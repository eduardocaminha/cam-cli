// src/commands/domain-docs.ts
//
// writeDomainDocsOnMain() -- commit the merged CONTEXT.md and any new ADR
// files directly to main in one atomic ref-only commit (style
// specifyIssueOnMain), so the domain-model output of /cam-spec is persisted
// without touching the working branch or the working tree.
//
// Design goals (mirrors src/commands/issue-specify.ts):
//   - CONTEXT.md is read from main via `git show main:CONTEXT.md`. A non-zero
//     exit means the file is absent (never created yet): treated as null,
//     never an error (lazy-creation, unlike journal.md which must pre-exist).
//   - docs/adr/ listing is read from main via `git ls-tree -r --name-only
//     main docs/adr/`. ADR numbers are allocated against this listing
//     (existing 0001..0009 -> 0010).
//   - Off-main / on-main path: same ref-only commitTreeToMain path either
//     way (CAM-133 rule: never a working-tree commit path).
//   - Push to origin main is best-effort.
//   - All external dependencies (spawnFn, clock, eventSink) are injectable.
//
// Guards (in order, before any mutation):
//   0. Up-to-date guard: detached-head, missing-main, diverged.
//   1. Validate payload via validateDomainDocsPayload from
//      src/domain-docs/render.ts.
//   2. Empty payload (no terms, no adrs) short-circuits as a no-op: no read,
//      no commit, no push.
//
// Idempotency: mergeContextMd (US-001) already guarantees byte-identical
// CONTEXT.md output when the same terms are merged twice. ADR creation is
// idempotent by title: an incoming adr whose slugified title already matches
// an existing docs/adr/NNNN-<slug>.md file is skipped (no duplicate file for
// the same decision).
//
// Commit message: `docs(cam): domain docs for <id>`.
//
// CAM-118 (US-002 spec-interview domain-docs writer).

import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

import {
	adrFilename,
	mergeContextMd,
	nextAdrNumber,
	renderAdr,
	slugifyAdrTitle,
	validateDomainDocsPayload,
} from '../domain-docs/render.ts';
import type { DomainDocsPayload } from '../domain-docs/render.ts';
import { checkMainUpToDate, commitTreeToMain, pushMainBestEffort } from '../git/on-main.ts';
import type { FileWrite, SpawnFn } from '../git/on-main.ts';
import { makeFileEventLogger } from '../supervisor/events.ts';
import type { WorkerEventLogger } from '../supervisor/events.ts';

// Re-export SpawnFn from the shared module so callers do not need to update
// their import paths.
export type { SpawnFn };

/** Returns the current ISO 8601 timestamp string. Injectable for tests. */
export type ClockFn = () => string;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WriteDomainDocsOnMainOptions {
	/** Absolute path to the project root (git repo). */
	cwd: string;
	/** Id the domain docs are being written for (drives the commit message). */
	id: string;
	/** Structured payload the /cam-spec flow assembled. */
	payload: DomainDocsPayload;
	/** Injectable spawnSync for all git subprocess calls. */
	spawnFn: SpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp. */
	clock: ClockFn;
	/**
	 * Injectable event sink for the 'domain-docs-written' observability event.
	 * Defaults to makeFileEventLogger(<cwd>/.claude/cam-worker-events.jsonl),
	 * the canonical production sink. Inject a fake in tests.
	 */
	eventSink?: WorkerEventLogger;
}

/** Successful outcome: docs committed to main (or a validated empty no-op). */
export interface WriteDomainDocsOnMainSuccess {
	ok: true;
	/** Short sha (7 chars) of the new commit on main. Empty string on noOp. */
	sha: string;
	/** Present (true) only for the empty-payload no-op path. */
	noOp?: true;
	/** Filenames (not full paths) of newly-created docs/adr/ files. */
	adrFiles: string[];
}

/** Guard or validation outcome: no commit was made. */
export type WriteDomainDocsOnMainError =
	| { ok: false; reason: 'diverged' | 'detached-head' | 'missing-main' }
	| { ok: false; reason: 'invalid-payload'; errors: string[] };

export type WriteDomainDocsOnMainOutcome =
	| WriteDomainDocsOnMainSuccess
	| WriteDomainDocsOnMainError;

// ---------------------------------------------------------------------------
// Read-from-main helpers
// ---------------------------------------------------------------------------

/**
 * Read CONTEXT.md from main via `git show main:CONTEXT.md`.
 * Returns null when the file is absent from main (lazy creation), never an
 * error: unlike journal.md, CONTEXT.md is not guaranteed to pre-exist.
 */
function readContextMdFromMain(cwd: string, spawnFn: SpawnFn): string | null {
	const result = spawnFn('git', ['-C', cwd, 'show', 'main:CONTEXT.md'], { encoding: 'utf8' });
	if ((result.status ?? 1) !== 0) return null;
	return result.stdout ?? '';
}

/**
 * Enumerate docs/adr/ filenames (basename only, not full path) as committed
 * on main, via `git ls-tree -r --name-only main docs/adr/`. Returns [] when
 * the directory is absent from main (lazy creation: docs/adr/ is created
 * only when the first ADR is needed).
 */
function readAdrFilenamesFromMain(cwd: string, spawnFn: SpawnFn): string[] {
	const result = spawnFn(
		'git',
		['-C', cwd, 'ls-tree', '-r', '--name-only', 'main', 'docs/adr/'],
		{ encoding: 'utf8' },
	);
	const paths = (result.stdout ?? '')
		.split('\n')
		.map((p) => p.trim())
		.filter(Boolean);
	return paths.map((p) => basename(p));
}

// ---------------------------------------------------------------------------
// ADR file builder (idempotent by slugified title)
// ---------------------------------------------------------------------------

/** Extracts the slug portion of an "NNNN-<slug>.md" filename (or null if it does not match). */
function slugFromAdrFilename(filename: string): string | null {
	const match = /^\d{4}-(.+)\.md$/.exec(filename);
	return match?.[1] ?? null;
}

/**
 * Builds the FileWrite list for any new (non-duplicate) ADR entries in the
 * payload, allocating sequential ADR numbers against `existingFilenames`.
 *
 * Idempotent by title: an incoming adr whose slugified title already matches
 * an existing (or already-processed-in-this-batch) ADR filename is skipped,
 * so re-running writeDomainDocsOnMain with the same payload never creates a
 * second ADR file for the same decision.
 */
function buildAdrFiles(
	payload: DomainDocsPayload,
	existingFilenames: string[],
): { files: FileWrite[]; adrFiles: string[] } {
	const files: FileWrite[] = [];
	const adrFiles: string[] = [];

	const seenSlugs = new Set<string>();
	for (const name of existingFilenames) {
		const slug = slugFromAdrFilename(name);
		if (slug !== null) seenSlugs.add(slug);
	}

	let filenamesSoFar = [...existingFilenames];

	for (const adr of payload.adrs) {
		const slug = slugifyAdrTitle(adr.title);
		if (seenSlugs.has(slug)) continue;

		const number = nextAdrNumber(filenamesSoFar);
		const filename = adrFilename(number, adr.title);
		const content = renderAdr(number, adr);

		files.push({ path: `docs/adr/${filename}`, content });
		adrFiles.push(filename);
		filenamesSoFar = [...filenamesSoFar, filename];
		seenSlugs.add(slug);
	}

	return { files, adrFiles };
}

// ---------------------------------------------------------------------------
// Event emission helper
// ---------------------------------------------------------------------------

/**
 * Emit a 'domain-docs-written' observability event.
 * Uses the injected sink when provided; falls back to the canonical
 * production file sink (makeFileEventLogger writing to
 * <cwd>/.claude/cam-worker-events.jsonl).
 */
function emitDomainDocsWritten(
	cwd: string,
	id: string,
	clock: ClockFn,
	adrFiles: string[],
	eventSink: WorkerEventLogger | undefined,
): void {
	const sink = eventSink ?? makeFileEventLogger(join(cwd, '.claude', 'cam-worker-events.jsonl'));
	sink({
		ts: clock(),
		storyId: id,
		uuid: randomUUID(),
		kind: 'domain-docs-written',
		detail: { id, adrFiles },
	});
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Commit the merged CONTEXT.md and any new ADR files directly to main in one
 * atomic ref-only commit.
 *
 * Guards (in order, before any mutation):
 *   0. Up-to-date guard (detached-head, missing-main, diverged).
 *   1. validateDomainDocsPayload -- invalid-payload error on failure.
 *   2. Empty payload (no terms, no adrs) -- returns { ok: true, noOp: true,
 *      sha: '', adrFiles: [] } with NO read, NO commit, NO push.
 *
 * Steps (non-noOp path):
 *   3. Read CONTEXT.md from main (null when absent -- lazy creation).
 *   4. Read docs/adr/ filenames from main.
 *   5. mergeContextMd(existing, payload.terms) -- merged CONTEXT.md content.
 *   6. buildAdrFiles -- new (non-duplicate) ADR files, sequentially numbered.
 *   7. commitTreeToMain([CONTEXT.md, ...adrFiles], `docs(cam): domain docs
 *      for <id>`) -- one atomic commit.
 *   8. Best-effort push to origin main.
 *   9. Emit 'domain-docs-written' observability event.
 */
export function writeDomainDocsOnMain(
	options: WriteDomainDocsOnMainOptions,
): WriteDomainDocsOnMainOutcome {
	const { cwd, id, payload, spawnFn, clock } = options;

	// Guard 0: up-to-date check.
	const guard = checkMainUpToDate(cwd, spawnFn, 'write domain docs');
	if (!guard.ok) {
		return guard;
	}
	const { localMainSha } = guard;

	// Guard 1: validate payload.
	const validation = validateDomainDocsPayload(payload);
	if (!validation.ok) {
		return { ok: false, reason: 'invalid-payload', errors: validation.errors };
	}

	// Guard 2: empty payload short-circuits as a no-op (no read, no commit, no push).
	if (payload.terms.length === 0 && payload.adrs.length === 0) {
		return { ok: true, sha: '', noOp: true, adrFiles: [] };
	}

	// Read existing state from main (never the working tree).
	const existingContext = readContextMdFromMain(cwd, spawnFn);
	const existingAdrFilenames = readAdrFilenamesFromMain(cwd, spawnFn);

	// Merge glossary terms and build any new ADR files.
	const mergedContext = mergeContextMd(existingContext, payload.terms);
	const { files: adrWrites, adrFiles } = buildAdrFiles(payload, existingAdrFilenames);

	const files: FileWrite[] = [{ path: 'CONTEXT.md', content: mergedContext }, ...adrWrites];

	const commitMsg = `docs(cam): domain docs for ${id}`;
	const sha = commitTreeToMain(cwd, files, commitMsg, localMainSha, spawnFn, 'cam-domain-docs-');

	pushMainBestEffort(cwd, spawnFn);

	emitDomainDocsWritten(cwd, id, clock, adrFiles, options.eventSink);

	return { ok: true, sha, adrFiles };
}
