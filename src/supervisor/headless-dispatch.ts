// src/supervisor/headless-dispatch.ts
//
// Runs ONE headless implementer dispatch end to end against a REAL spawned
// child process. US-003 (CAM-516).
//
// Writes the stream-json input message to the child's stdin FileSink,
// consumes the NDJSON stdout through headless-stream.ts's classifier
// (US-002), appends every raw line verbatim to the per-dispatch log
// (headless-log.ts, US-002), and resolves once the dispatch reaches a
// terminal state:
//
//   1. the child's own stdout stream ending (EOF, i.e. the child exited), or
//   2. an idle budget measured from the timestamp of the LAST received
//      event -- GOTCHA E: completion detection is NEVER a pane probe. The
//      interactive tmux path's `isPaneAlive` check has no referent for a
//      real child process; this idle budget is the direct replacement. The
//      Warren precedent this mirrors is 45 minutes, born from a real
//      incident (DEFAULT_HEADLESS_IDLE_BUDGET_MS below), and is injectable
//      via `idleBudgetMs` so tests can use milliseconds.
//
// No TTY is ever allocated: `terminal` is the ONLY `Bun.spawn` option that
// attaches a PTY (officialDocsValidated pin, bun.sh/docs/api/spawn), so
// simply never passing it is the whole contract -- GOTCHA F is the
// mirror-image hazard on the container side (`dockerExecWrap`'s `-it`).

import type { HeadlessDispatchLogWriter } from './headless-log.ts';
import { classifyHeadlessStreamLine } from './headless-stream.ts';

/** Warren precedent (GOTCHA E): 45 minutes measured from the last received event. */
export const DEFAULT_HEADLESS_IDLE_BUDGET_MS = 45 * 60 * 1000;

/** Signal sent to the child when the idle budget elapses (SIGTERM: abort-turn + exit 143 per the CLI docs pin on this story). */
const IDLE_KILL_SIGNAL = 'SIGTERM';

/** Inputs to {@link runHeadlessDispatch}. */
export interface RunHeadlessDispatchOptions {
	/** Child argv, e.g. from `buildHeadlessChildInvocation` (US-001). */
	argv: string[];
	/** Explicit child env, e.g. from `buildHeadlessChildInvocation` (US-001). */
	env: Record<string, string | undefined>;
	/** Child working directory. Defaults to the current process cwd when omitted. */
	cwd?: string;
	/** The single stream-json input message to write to the child's stdin, then close. */
	inputMessage: string;
	/** Per-dispatch log writer (US-002, `openHeadlessDispatchLog`). Every raw stdout line is appended verbatim. */
	log: HeadlessDispatchLogWriter;
	/** Idle budget in ms, measured from the last received event. Defaults to {@link DEFAULT_HEADLESS_IDLE_BUDGET_MS}. */
	idleBudgetMs?: number;
}

/**
 * Terminal outcome of one headless dispatch.
 *
 *   'completed'    - the child's stdout stream ended (the child exited) before
 *                     the idle budget elapsed. Carries the real child exit code
 *                     and the last `result` event's `total_cost_usd`, if any
 *                     `result` event was ever received.
 *   'idle-timeout' - no event arrived within the idle budget; the child was
 *                     killed. Never a success, never a hang.
 */
export type HeadlessDispatchOutcome =
	| { kind: 'completed'; exitCode: number; totalCostUsd: number | undefined }
	| { kind: 'idle-timeout'; totalCostUsd: number | undefined };

/**
 * The exact `Bun.Subprocess` instantiation this module always spawns with
 * (`stdin: 'pipe', stdout: 'pipe', stderr: 'ignore'`, no `terminal`). Used
 * below to derive the stdout stream / reader / read-result types straight
 * from Bun's own generic instead of naming the ambient global
 * `ReadableStream` identifier directly -- under this repo's `lib: ["ESNext"]`
 * tsconfig (no `dom` lib), that global identifier resolves to
 * `node:stream/web`'s narrower `ReadableStreamDefaultReader` (missing Bun's
 * `readMany`), which is incompatible with what `proc.stdout.getReader()`
 * actually returns.
 */
type HeadlessChildProcess = Bun.Subprocess<'pipe', 'pipe', 'ignore'>;

/**
 * `getReader` is overloaded (a zero-arg default-reader form and a
 * `{ mode: 'byob' }` form); `ReturnType<HeadlessChildProcess['stdout']['getReader']>`
 * resolves to the LAST overload's (union) return type rather than the
 * zero-arg one this module actually calls. Calling it here, with the exact
 * zero-arg shape this module uses, pins the correct overload so the derived
 * types below are the real default-reader ones.
 */
function getDefaultStdoutReader(stdout: HeadlessChildProcess['stdout']) {
	return stdout.getReader();
}
type HeadlessChildStdoutReader = ReturnType<typeof getDefaultStdoutReader>;
type HeadlessChildReadResult = Awaited<ReturnType<HeadlessChildStdoutReader['read']>>;

/** Outcome of racing one `reader.read()` against the remaining idle budget. */
type ReadRace = { kind: 'idle' } | { kind: 'read'; result: HeadlessChildReadResult };

/**
 * Race a single `reader.read()` call against `remainingMs` of idle budget.
 * Both the timer and the read settle inside the same executor scope so
 * neither TS nor a real race condition can observe a partially-initialized
 * timer handle.
 */
function raceReadAgainstIdle(reader: HeadlessChildStdoutReader, remainingMs: number): Promise<ReadRace> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve({ kind: 'idle' }), remainingMs);
		reader.read().then(
			(result) => {
				clearTimeout(timer);
				resolve({ kind: 'read', result });
			},
			() => {
				// A read error (e.g. the stream was cancelled elsewhere) is treated
				// as stream-ended: the caller's loop exits via `done: true`.
				clearTimeout(timer);
				resolve({ kind: 'read', result: { done: true, value: undefined } });
			},
		);
	});
}

/**
 * Consume `stdout` line by line, calling `onLine` for every complete NDJSON
 * line (in arrival order), resetting the idle deadline on every line
 * received. Resolves 'stream-ended' on EOF, or 'idle-timeout' once
 * `idleBudgetMs` elapses since the last received chunk without the stream
 * ending.
 */
async function consumeStdoutWithIdleBudget(
	stdout: HeadlessChildProcess['stdout'],
	idleBudgetMs: number,
	onLine: (line: string) => void,
): Promise<'stream-ended' | 'idle-timeout'> {
	const reader = getDefaultStdoutReader(stdout);
	const decoder = new TextDecoder();
	let buffer = '';
	let lastEventAt = Date.now();

	for (;;) {
		const remainingMs = Math.max(0, idleBudgetMs - (Date.now() - lastEventAt));
		const race = await raceReadAgainstIdle(reader, remainingMs);

		if (race.kind === 'idle') {
			await reader.cancel().catch(() => {});
			return 'idle-timeout';
		}

		lastEventAt = Date.now();
		const { done, value } = race.result;
		if (done) {
			if (buffer.length > 0) onLine(buffer);
			return 'stream-ended';
		}

		buffer += decoder.decode(value, { stream: true });
		let newlineIdx = buffer.indexOf('\n');
		while (newlineIdx >= 0) {
			const line = buffer.slice(0, newlineIdx);
			buffer = buffer.slice(newlineIdx + 1);
			if (line.length > 0) onLine(line);
			newlineIdx = buffer.indexOf('\n');
		}
	}
}

/**
 * Run one headless implementer dispatch against a real spawned child (never
 * an in-process mock). See the module header for the completion contract.
 */
export async function runHeadlessDispatch(opts: RunHeadlessDispatchOptions): Promise<HeadlessDispatchOutcome> {
	const idleBudgetMs = opts.idleBudgetMs ?? DEFAULT_HEADLESS_IDLE_BUDGET_MS;

	// No `terminal` option: this is the entire no-TTY contract (see module
	// header). `stdin: 'pipe'` yields a FileSink; `stdout: 'pipe'` yields a
	// ReadableStream<Uint8Array>.
	const proc = Bun.spawn({
		cmd: opts.argv,
		env: opts.env,
		...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'ignore',
	});

	const message = opts.inputMessage.endsWith('\n') ? opts.inputMessage : `${opts.inputMessage}\n`;
	proc.stdin.write(message);
	proc.stdin.end();

	let totalCostUsd: number | undefined;
	const onLine = (line: string): void => {
		opts.log.appendLine(line);
		const event = classifyHeadlessStreamLine(line);
		if (event.kind === 'result') {
			totalCostUsd = event.totalCostUsd;
		}
	};

	const streamOutcome = await consumeStdoutWithIdleBudget(proc.stdout, idleBudgetMs, onLine);

	if (streamOutcome === 'idle-timeout') {
		proc.kill(IDLE_KILL_SIGNAL);
		await proc.exited;
		return { kind: 'idle-timeout', totalCostUsd };
	}

	const exitCode = await proc.exited;
	return { kind: 'completed', exitCode, totalCostUsd };
}
