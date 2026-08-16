// src/commands/spec.ts
//
// Deterministic stdin write channels retained for internal legacy consumers.
// Operator-facing specification now belongs to the web runtime.
//
// Acceptance criteria (US-003, --write-docs path):
//   1. `echo '<json>' | gship spec --write-docs <id>` reads the DomainDocsPayload
//      from stdin and calls writeDomainDocsOnMain in-process: NO tmux calls,
//      no send-keys, no pane bootstrap, no orchestrator liveness check.
//   2. Exit 0 on { ok: true } including noOp (prints a muted hint); exit 1 on
//      malformed stdin JSON, invalid payload (errors printed), or a guard
//      failure (diverged / detached-head / missing-main).
//
// Acceptance criteria (US-001, CAM-213, --persist path):
//   1. `echo '<json>' | gship spec --persist <id>` reads
//      { spec, wsjf, blockedBy?, type? } from stdin and calls
//      specifyIssueOnMain in-process: NO tmux calls, no send-keys, no pane
//      bootstrap, no orchestrator liveness check. type (US-002, CAM-235) is
//      optional and forwarded as-is; specifyIssueOnMain validates it.
//   2. Exit 0 on { ok: true }, printing CAM_SPEC_RESULT=<id> sha=<sha> plus a
//      human hint; exit 1 on malformed stdin JSON (reason=invalid-json) or any
//      specifyIssueOnMain guard/validation failure, printing
//      CAM_SPEC_RESULT=ERROR reason=<reason>.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import process from 'node:process';

import { printError, printHint } from '../logging/color.ts';
import { emitMutedHint } from '../logging/screen.ts';
import {
	writeDomainDocsOnMain,
	type ClockFn,
	type SpawnFn as OnMainSpawnFn,
	type WriteDomainDocsOnMainOutcome,
} from './domain-docs.ts';
import { specifyIssueOnMain, type SpecifyIssueOnMainOutcome } from './issue-specify.ts';
import type { Spec } from '../issues/spec.ts';
import type { IssueEntry, WsjfScore } from '../issues/types.ts';
import type { DomainDocsPayload } from '../domain-docs/render.ts';

// --- --write-docs entrypoint (US-003, CAM-118) ------------------------------

export interface SpecWriteDocsOptions {
	/** Id the domain docs are being written for (drives the commit message). */
	id: string;
	/** Override the working directory; default `process.cwd()`. */
	cwd?: string;
	/**
	 * Injectable stdin reader. Default: `Bun.stdin.text()` (matches the
	 * `cam journal append` / `cam issue --file-local` stdin-JSON convention).
	 */
	readStdin?: () => Promise<string>;
	/**
	 * Injectable spawnSync-based git plumbing fn, passed through to
	 * writeDomainDocsOnMain. Default: a `spawnSync` wrapper over `git`.
	 */
	spawnFn?: OnMainSpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp. Default: `new Date().toISOString()`. */
	clock?: ClockFn;
	/** Injectable stdout writer. Default: `process.stdout.write`. */
	writeStdout?: (line: string) => void;
	/**
	 * Injectable full bypass of stdin-read + writeDomainDocsOnMain, for
	 * branch-isolation unit tests. When present, `readStdin`/`spawnFn`/`clock`
	 * are never consulted.
	 */
	writeFn?: (payload: unknown) => WriteDomainDocsOnMainOutcome;
}

/**
 * `gship spec --write-docs <id>`: read a DomainDocsPayload as JSON from stdin
 * and call writeDomainDocsOnMain in-process. NO tmux calls, no send-keys, no
 * pane bootstrap, no orchestrator liveness check -- this is the write channel
 * FOR the orchestrator (the orchestrator's own tools disallow Edit/Write/
 * NotebookEdit), mirroring `cam journal append` / `cam issue --file-local`.
 *
 * Returns 0 on `{ ok: true }` (including the noOp outcome, which prints a
 * muted "nothing to write" hint); returns 1 on malformed stdin JSON, an
 * invalid payload (validation errors printed), or a guard failure (diverged /
 * detached-head / missing-main).
 */
export async function runSpecWriteDocs(options: SpecWriteDocsOptions): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const readStdin = options.readStdin ?? (() => Bun.stdin.text());
	const writeStdout =
		options.writeStdout ?? ((line: string) => { process.stdout.write(line); });
	const clock = options.clock ?? (() => new Date().toISOString());
	const spawnFn: OnMainSpawnFn =
		options.spawnFn ??
		((cmd, args, opts) => spawnSync(cmd, args, { ...opts, stdio: 'pipe' }) as SpawnSyncReturns<string>);

	const stdinText = await readStdin();
	let payload: unknown;
	try {
		payload = JSON.parse(stdinText);
	} catch (err) {
		printError(`gship spec --write-docs: invalid JSON from stdin: ${String(err)}`);
		return 1;
	}

	const outcome: WriteDomainDocsOnMainOutcome = options.writeFn
		? options.writeFn(payload)
		: writeDomainDocsOnMain({
				cwd,
				id: options.id,
				payload: payload as DomainDocsPayload,
				spawnFn,
				clock,
			});

	if (!outcome.ok) {
		if (outcome.reason === 'invalid-payload') {
			printError('gship spec --write-docs: invalid payload', outcome.errors.join('; '));
		} else {
			printError(
				`gship spec --write-docs: ${outcome.reason}`,
				'ensure main is up to date and you are not on a detached HEAD, then retry.',
			);
		}
		return 1;
	}

	if (outcome.noOp) {
		emitMutedHint('nothing to write (empty payload: no terms, no adrs)');
		return 0;
	}

	writeStdout(`CAM_DOMAIN_DOCS_WRITTEN=${options.id} sha=${outcome.sha}\n`);
	return 0;
}

// --- --persist entrypoint (US-001, CAM-213) ---------------------------------

/** Stdin payload shape for `gship spec --persist <id>`. */
interface SpecPersistPayload {
	spec: Spec;
	wsjf: WsjfScore;
	blockedBy?: string[];
	/**
	 * Optional issue type captured during the spec interview (US-002, CAM-235).
	 * Forwarded as-is to specifyIssueOnMain, which validates it; a payload
	 * without type leaves the issue entry without a type key.
	 */
	type?: IssueEntry['type'];
}

export interface SpecPersistOptions {
	/** Id of the issue to persist the spec for (e.g. 'CAM-42'). */
	id: string;
	/** Override the working directory; default `process.cwd()`. */
	cwd?: string;
	/**
	 * Injectable stdin reader. Default: `Bun.stdin.text()` (matches the
	 * `gship journal append` / `gship issue --file-local` / `gship spec --write-docs`
	 * stdin-JSON convention).
	 */
	readStdin?: () => Promise<string>;
	/**
	 * Injectable spawnSync-based git plumbing fn, passed through to
	 * specifyIssueOnMain. Default: a `spawnSync` wrapper over `git`.
	 */
	spawnFn?: OnMainSpawnFn;
	/** Injectable clock -- returns ISO 8601 timestamp. Default: `new Date().toISOString()`. */
	clock?: ClockFn;
	/** Injectable stdout writer. Default: `process.stdout.write`. */
	writeStdout?: (line: string) => void;
	/**
	 * Injectable full bypass of stdin-read + specifyIssueOnMain, for
	 * branch-isolation unit tests. When present, `readStdin`/`spawnFn`/`clock`
	 * are never consulted.
	 */
	persistFn?: (payload: unknown) => SpecifyIssueOnMainOutcome;
}

/**
 * `gship spec --persist <id>`: read { spec, wsjf, blockedBy?, type? } as JSON
 * from stdin and call specifyIssueOnMain directly. NO tmux calls, no
 * send-keys, no pane bootstrap, no orchestrator liveness check -- this is the
 * deterministic persist channel FOR the orchestrator (a read-only agent with
 * no Task/inline-TS path), mirroring `gship spec --write-docs` /
 * `cam journal append` / `cam issue --file-local`.
 *
 * specifyIssueOnMain already validates spec + wsjf + type and enforces all
 * guards; this function only marshals stdin and maps the resulting
 * discriminated union to exit code + machine-readable CAM_SPEC_RESULT line.
 *
 * Returns 0 on `{ ok: true }`; returns 1 on malformed stdin JSON
 * (reason=invalid-json, specifyIssueOnMain is never called) or any
 * specifyIssueOnMain guard/validation failure.
 */
export async function runSpecPersist(options: SpecPersistOptions): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const readStdin = options.readStdin ?? (() => Bun.stdin.text());
	const writeStdout =
		options.writeStdout ?? ((line: string) => { process.stdout.write(line); });
	const clock = options.clock ?? (() => new Date().toISOString());
	const spawnFn: OnMainSpawnFn =
		options.spawnFn ??
		((cmd, args, opts) => spawnSync(cmd, args, { ...opts, stdio: 'pipe' }) as SpawnSyncReturns<string>);

	const stdinText = await readStdin();
	let payload: unknown;
	try {
		payload = JSON.parse(stdinText);
	} catch (err) {
		printError(`gship spec --persist: invalid JSON from stdin: ${String(err)}`);
		writeStdout('CAM_SPEC_RESULT=ERROR reason=invalid-json\n');
		return 1;
	}

	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
		printError(
			'gship spec --persist: invalid payload',
			'top-level JSON must be a non-null object with spec/wsjf fields',
		);
		writeStdout('CAM_SPEC_RESULT=ERROR reason=invalid-spec\n');
		return 1;
	}

	const outcome: SpecifyIssueOnMainOutcome = options.persistFn
		? options.persistFn(payload)
		: specifyIssueOnMain({
				cwd,
				id: options.id,
				spec: (payload as SpecPersistPayload).spec,
				wsjf: (payload as SpecPersistPayload).wsjf,
				blockedBy: (payload as SpecPersistPayload).blockedBy,
				type: (payload as SpecPersistPayload).type,
				spawnFn,
				clock,
			});

	if (!outcome.ok) {
		if (
			outcome.reason === 'invalid-spec' ||
			outcome.reason === 'invalid-wsjf' ||
			outcome.reason === 'invalid-type' ||
			outcome.reason === 'integrity-error'
		) {
			printError(`gship spec --persist: ${outcome.reason}`, outcome.errors.join('; '));
		} else {
			printError(
				`gship spec --persist: ${outcome.reason}`,
				'ensure the issue is stage:idea/status:open and main is up to date, then retry.',
			);
		}
		writeStdout(`CAM_SPEC_RESULT=ERROR reason=${outcome.reason}\n`);
		return 1;
	}

	printHint(`specified ${outcome.id} on main (${outcome.sha})`);
	writeStdout(`CAM_SPEC_RESULT=${outcome.id} sha=${outcome.sha}\n`);
	return 0;
}
