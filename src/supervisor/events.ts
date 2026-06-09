// src/supervisor/events.ts
//
// Structured per-story worker observability events (US-013).
//
// The supervisor appends one JSON line per worker lifecycle step to
// .claude/cam-worker-events.jsonl so an operator diagnosing a loop can replay
// exactly what happened: when each worker started, when it ended, what the
// outcome was, and how many tokens its session burned.
//
// The 'result' event detail is RICH enough to be the canonical per-story
// factual record (so a follow-up, CAM-31, can retire progress.txt's per-story
// prose). The durable Codebase Patterns prose stays a SEPARATE concern, kept
// out of this log.
//
// Design decisions:
//   - The logger is injected (default: append-to-file) so tests collect events
//     in memory without touching the filesystem.
//   - The default file logger is SYNCHRONOUS (appendFileSync) to match the
//     supervisor's all-synchronous injected I/O. (appendFileSync is Bun's own
//     fs primitive; an async Bun.file().writer() would force every emit site in
//     the loop to await and the in-memory test collector to go async too.)
//   - readWorkerTokens resolves the per-story transcript via
//     transcriptPathForSession (US-002) and sums usage with parseTranscriptUsage
//     (reused from src/transcript/usage.ts).

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { parseTranscriptUsage, transcriptPathForSession } from '../transcript/usage.ts';
import type { WorkerOutcome, WorkerOutcomeKind } from './result.ts';

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** Lifecycle step a WorkerEvent records. */
export type WorkerEventKind = 'worker-start' | 'worker-end' | 'result' | 'tokens';

/** Gate status recorded in a 'result' event. */
export type GateStatus = 'pass' | 'fail' | 'unknown';

/** One Step-5.5 docs-validation entry, mirrored from handoff.json. */
export interface DocValidatedEntry {
	lib: string;
	status: string;
	url?: string;
}

/** Rich 'result' event detail: the canonical per-story factual record. */
export interface ResultEventDetail {
	/** Worker outcome kind (pass / incomplete / fail / blocked / unknown). */
	outcome: WorkerOutcomeKind;
	/** Files the worker created or modified (from handoff.json). */
	filesChanged: string[];
	/** Quality-gate verdicts the supervisor can attest to. */
	gates: { typecheck: GateStatus; tests: GateStatus };
	/** Step-5.5 docs validated by the worker (from handoff.json). */
	docsValidated: DocValidatedEntry[];
}

/** 'tokens' event detail: per-story session token usage. */
export interface TokensEventDetail {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
}

/** Detail payload by event kind ('worker-start'/'worker-end' carry free-form maps). */
export type WorkerEventDetail = ResultEventDetail | TokensEventDetail | Record<string, unknown>;

/** A single structured worker lifecycle event. */
export interface WorkerEvent {
	/** ISO timestamp the event was emitted. */
	ts: string;
	/** Story id (advisory at worker-start, actual once known). May be undefined. */
	storyId: string | undefined;
	/** Worker session uuid; constant across one worker's whole lifecycle. */
	uuid: string;
	/** Which lifecycle step this records. */
	kind: WorkerEventKind;
	/** Event-specific payload. */
	detail: WorkerEventDetail;
}

/** Injected event sink. The default appends a JSON line to a file. */
export type WorkerEventLogger = (event: WorkerEvent) => void;

/** Subset of handoff.json this module reads to build the 'result' detail. */
export interface HandoffForResult {
	createdFiles?: string[];
	modifiedFiles?: string[];
	officialDocsValidated?: Array<{ lib?: string; status?: string; url?: string }>;
}

// ---------------------------------------------------------------------------
// Loggers
// ---------------------------------------------------------------------------

/**
 * Append-to-file logger: one JSON line per event at `path`.
 * Creates the parent directory if it does not exist.
 */
export function makeFileEventLogger(path: string): WorkerEventLogger {
	return (event: WorkerEvent) => {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
	};
}

/**
 * In-memory logger for tests. Returns the logger plus the backing array so a
 * test can assert on the captured events.
 */
export function makeInMemoryEventLogger(): { logger: WorkerEventLogger; events: WorkerEvent[] } {
	const events: WorkerEvent[] = [];
	const logger: WorkerEventLogger = (event) => {
		events.push(event);
	};
	return { logger, events };
}

// ---------------------------------------------------------------------------
// Detail builders
// ---------------------------------------------------------------------------

/**
 * Build the rich 'result' event detail from a worker outcome + handoff.
 *
 * - filesChanged = handoff.createdFiles ++ handoff.modifiedFiles.
 * - gates: the supervisor has no per-worker gate transcript, so a 'pass'
 *   outcome records both gates as 'pass' (prd.json passes:true is the
 *   corroboration the worker's gates were green); every other outcome records
 *   'unknown'.
 * - docsValidated mirrors handoff.officialDocsValidated (lib + status [+ url]).
 */
export function buildResultDetail(
	outcome: WorkerOutcome,
	handoff: HandoffForResult | null,
): ResultEventDetail {
	const created = handoff?.createdFiles ?? [];
	const modified = handoff?.modifiedFiles ?? [];
	const gate: GateStatus = outcome.kind === 'pass' ? 'pass' : 'unknown';
	const docsValidated: DocValidatedEntry[] = (handoff?.officialDocsValidated ?? []).map((d) => {
		const entry: DocValidatedEntry = { lib: d.lib ?? 'unknown', status: d.status ?? 'unknown' };
		if (d.url !== undefined) entry.url = d.url;
		return entry;
	});
	return {
		outcome: outcome.kind,
		filesChanged: [...created, ...modified],
		gates: { typecheck: gate, tests: gate },
		docsValidated,
	};
}

/**
 * Read the per-story transcript for `uuid` and return its token usage.
 *
 * Resolves the JSONL via transcriptPathForSession (US-002), reads it with the
 * injected `readFile` (default: synchronous node/Bun fs), and sums usage with
 * parseTranscriptUsage. Returns null when the transcript is absent or
 * unreadable, so the supervisor can skip the 'tokens' event rather than record
 * misleading zeros.
 */
export function readWorkerTokens(
	uuid: string,
	cwd: string,
	claudeDir: string,
	readFile: (path: string) => string | null = defaultReadFile,
): TokensEventDetail | null {
	const path = transcriptPathForSession(uuid, cwd, claudeDir);
	const jsonl = readFile(path);
	if (jsonl === null) return null;
	const usage = parseTranscriptUsage(jsonl);
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
	};
}

function defaultReadFile(path: string): string | null {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}
