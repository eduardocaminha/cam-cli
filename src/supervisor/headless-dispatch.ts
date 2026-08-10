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
//   1. the child exiting after its stdout stream ends, or
//   2. an idle budget measured from the timestamp of the LAST received
//      event -- GOTCHA E: completion detection is NEVER a pane probe. The
//      interactive tmux path's `isPaneAlive` check has no referent for a
//      real child process; this idle budget is the direct replacement. The
//      Warren precedent this mirrors is 45 minutes, born from a real
//      incident (DEFAULT_HEADLESS_IDLE_BUDGET_MS below), and is injectable
//      via `idleBudgetMs` so tests can use milliseconds, or
//   3. an ABSOLUTE wall-clock deadline measured from dispatch start, never
//      reset by an event (US-R1-006, CAM-516). The idle budget above is
//      resettable by design (it exists to tolerate long *thinking* gaps
//      between events), which means it never bounds a CHATTY runaway child:
//      one that keeps emitting SOME event before every idle-budget tick
//      elapses runs forever. The tmux poll loop's own per-dispatch ceiling
//      (`perWorkerTimeoutMs`, loop.ts) is exactly this kind of non-resettable
//      wall-clock bound; `absoluteTimeoutMs` below is the headless-path
//      equivalent, wired from the SAME `perWorkerTimeoutMs` value
//      (host.ts) so both dispatch paths share one ceiling.
//
// No TTY is ever allocated: `terminal` is the ONLY `Bun.spawn` option that
// attaches a PTY (officialDocsValidated pin, bun.sh/docs/api/spawn), so
// simply never passing it is the whole contract -- GOTCHA F is the
// mirror-image hazard on the container side (`dockerExecWrap`'s `-it`).

import type { HeadlessDispatchLogWriter } from './headless-log.ts';
import { classifyHeadlessStreamLine } from './headless-stream.ts';

/** Warren precedent (GOTCHA E): 45 minutes measured from the last received event. */
export const DEFAULT_HEADLESS_IDLE_BUDGET_MS = 45 * 60 * 1000;

/** Cooperative signal sent when either dispatch deadline elapses. */
const TERMINATE_SIGNAL = 'SIGTERM';

/** Maximum time allowed for cooperative shutdown before SIGKILL escalation. */
const TERMINATION_GRACE_MS = 250;

/** Forceful signal used when the child does not honor SIGTERM within the grace period. */
const FORCE_KILL_SIGNAL = 'SIGKILL';

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
	/**
	 * Absolute wall-clock cap in ms, measured from dispatch start and NEVER
	 * reset by an event (US-R1-006, CAM-516). Optional: when omitted, only
	 * the resettable `idleBudgetMs` bound applies, i.e. a chatty child that
	 * always emits an event before the idle deadline elapses is unbounded.
	 * Callers wire the same `perWorkerTimeoutMs` the tmux poll loop already
	 * enforces (see the module header).
	 */
	absoluteTimeoutMs?: number;
	/**
	 * Return the cumulative spend when the configured worker-token ceiling has
	 * been crossed, otherwise undefined. The supervisor closes this probe over
	 * its existing readWorkerTokens(uuid) reader and maxWorkerTokens value.
	 */
	tokenCeilingProbe?: () => number | undefined;
	/** Poll cadence for tokenCeilingProbe. Defaults to 5 seconds when a probe is supplied. */
	tokenPollIntervalMs?: number;
}

/**
 * Terminal outcome of one headless dispatch.
 *
 *   'completed'        - the child's stdout stream ended (the child exited)
 *                         before the idle budget or the absolute deadline
 *                         elapsed. Carries the real child exit code and the
 *                         last `result` event's `total_cost_usd`, if any
 *                         `result` event was ever received.
 *   'idle-timeout'     - no event arrived within the idle budget; the child
 *                         was killed. Never a success, never a hang.
 *   'absolute-timeout' - `absoluteTimeoutMs` elapsed since dispatch start
 *                         (US-R1-006, CAM-516), regardless of how recently an
 *                         event arrived; the child was killed. Distinct from
 *                         'idle-timeout' so a caller/operator can tell a
 *                         genuinely stuck child (idle) apart from a chatty
 *                         runaway one (absolute).
 *   'token-ceiling'    - the supervisor's transcript reader observed spend
 *                         at or above maxWorkerTokens; the child was killed.
 */
export type HeadlessDispatchOutcome =
	| { kind: 'completed'; exitCode: number; totalCostUsd: number | undefined }
	| { kind: 'idle-timeout'; totalCostUsd: number | undefined }
	| { kind: 'absolute-timeout'; totalCostUsd: number | undefined }
	| { kind: 'token-ceiling'; tokenSpend: number; totalCostUsd: number | undefined };

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

/** Outcome of racing one `reader.read()` against the next scheduled check. */
type ReadRace = { kind: 'timer' } | { kind: 'read'; result: HeadlessChildReadResult };

type ReadTimeoutBudget = {
	remainingMs: number;
	timeoutKind: 'idle-timeout' | 'absolute-timeout' | 'token-check';
};

type ExitRace = { kind: 'exited'; exitCode: number } | { kind: 'absolute-timeout' };
type StreamOutcome =
	| { kind: 'stream-ended' }
	| { kind: 'idle-timeout' }
	| { kind: 'absolute-timeout' }
	| { kind: 'token-ceiling'; tokenSpend: number };
type ProcessedRead = { kind: 'stream-ended' } | { kind: 'continue'; buffer: string };

/** Select the first deadline the next stdout read can reach. */
function resolveReadTimeoutBudget(
	idleBudgetMs: number,
	lastEventAt: number,
	absoluteDeadlineAt: number | undefined,
	tokenPollIntervalMs: number | undefined,
): ReadTimeoutBudget {
	const idleRemainingMs = Math.max(0, idleBudgetMs - (Date.now() - lastEventAt));
	const absoluteRemainingMs =
		absoluteDeadlineAt !== undefined ? Math.max(0, absoluteDeadlineAt - Date.now()) : undefined;
	let budget: ReadTimeoutBudget = { remainingMs: idleRemainingMs, timeoutKind: 'idle-timeout' };

	if (absoluteRemainingMs !== undefined && absoluteRemainingMs <= idleRemainingMs) {
		budget = { remainingMs: absoluteRemainingMs, timeoutKind: 'absolute-timeout' };
	}

	if (tokenPollIntervalMs !== undefined && tokenPollIntervalMs < budget.remainingMs) {
		return { remainingMs: tokenPollIntervalMs, timeoutKind: 'token-check' };
	}

	return budget;
}

/** Treat a read error (for example, cancellation elsewhere) as stream-ended. */
function readStdout(reader: HeadlessChildStdoutReader): Promise<HeadlessChildReadResult> {
	return reader.read().catch(() => ({ done: true, value: undefined }));
}

/** Race one pending stdout read against `remainingMs` of idle budget. */
function raceReadAgainstTimer(
	pendingRead: Promise<HeadlessChildReadResult>,
	remainingMs: number,
): Promise<ReadRace> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve({ kind: 'timer' }), remainingMs);
		pendingRead.then((result) => {
			clearTimeout(timer);
			resolve({ kind: 'read', result });
		});
	});
}

/** Decode one stdout read result and emit every complete non-empty NDJSON line. */
function processStdoutReadResult(
	result: HeadlessChildReadResult,
	decoder: TextDecoder,
	buffer: string,
	onLine: (line: string) => void,
): ProcessedRead {
	const { done, value } = result;
	if (done) {
		if (buffer.length > 0) onLine(buffer);
		return { kind: 'stream-ended' };
	}

	let nextBuffer = buffer + decoder.decode(value, { stream: true });
	let newlineIdx = nextBuffer.indexOf('\n');
	while (newlineIdx >= 0) {
		const line = nextBuffer.slice(0, newlineIdx);
		nextBuffer = nextBuffer.slice(newlineIdx + 1);
		if (line.length > 0) onLine(line);
		newlineIdx = nextBuffer.indexOf('\n');
	}
	return { kind: 'continue', buffer: nextBuffer };
}

/**
 * Consume `stdout` line by line, calling `onLine` for every complete NDJSON
 * line (in arrival order), resetting the idle deadline on every line
 * received. Resolves 'stream-ended' on EOF, 'idle-timeout' once
 * `idleBudgetMs` elapses since the last received chunk without the stream
 * ending, or 'absolute-timeout' once `absoluteDeadlineAt` (a fixed
 * wall-clock instant, NEVER reset by an event) is reached first
 * (US-R1-006, CAM-516). When tokenCeilingProbe is supplied, it is also
 * checked after every stdout chunk and at tokenPollIntervalMs while stdout
 * is silent; a reported breach resolves 'token-ceiling'.
 */
async function consumeStdoutWithIdleBudget(
	stdout: HeadlessChildProcess['stdout'],
	idleBudgetMs: number,
	absoluteDeadlineAt: number | undefined,
	tokenCeilingProbe: (() => number | undefined) | undefined,
	tokenPollIntervalMs: number | undefined,
	onLine: (line: string) => void,
): Promise<StreamOutcome> {
	const reader = getDefaultStdoutReader(stdout);
	const decoder = new TextDecoder();
	let buffer = '';
	let lastEventAt = Date.now();
	let pendingRead = readStdout(reader);

	for (;;) {
		const tokenSpend = tokenCeilingProbe?.();
		if (tokenSpend !== undefined) {
			await reader.cancel().catch(() => {});
			return { kind: 'token-ceiling', tokenSpend };
		}

		const { remainingMs, timeoutKind } = resolveReadTimeoutBudget(
			idleBudgetMs,
			lastEventAt,
			absoluteDeadlineAt,
			tokenPollIntervalMs,
		);
		const race = await raceReadAgainstTimer(pendingRead, remainingMs);

		if (race.kind === 'timer') {
			if (timeoutKind === 'token-check') continue;
			await reader.cancel().catch(() => {});
			return { kind: timeoutKind };
		}

		lastEventAt = Date.now();
		const processedRead = processStdoutReadResult(race.result, decoder, buffer, onLine);
		if (processedRead.kind === 'stream-ended') {
			return { kind: 'stream-ended' };
		}
		buffer = processedRead.buffer;
		pendingRead = readStdout(reader);
	}
}

/** Terminate a timed-out child without letting a stuck SIGTERM handler defeat the deadline. */
async function terminateTimedOutChild(proc: HeadlessChildProcess): Promise<void> {
	proc.kill(TERMINATE_SIGNAL);

	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	const exitOutcome = await Promise.race([
		proc.exited.then(() => 'exited' as const),
		new Promise<'grace-expired'>((resolve) => {
			graceTimer = setTimeout(() => resolve('grace-expired'), TERMINATION_GRACE_MS);
		}),
	]);
	if (graceTimer !== undefined) clearTimeout(graceTimer);

	if (exitOutcome === 'grace-expired') {
		try {
			proc.kill(FORCE_KILL_SIGNAL);
		} catch {
			// The child exited between the grace timer firing and signal delivery.
		}
		await proc.exited;
	}
}

/** Wait for child exit without allowing EOF to escape the absolute deadline. */
async function waitForExitBeforeAbsoluteDeadline(
	proc: HeadlessChildProcess,
	absoluteDeadlineAt: number | undefined,
): Promise<ExitRace> {
	if (absoluteDeadlineAt === undefined) {
		return { kind: 'exited', exitCode: await proc.exited };
	}

	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const exitRace = await Promise.race([
		proc.exited.then((exitCode) => ({ kind: 'exited', exitCode }) as const),
		new Promise<{ kind: 'absolute-timeout' }>((resolve) => {
			deadlineTimer = setTimeout(
				() => resolve({ kind: 'absolute-timeout' }),
				Math.max(0, absoluteDeadlineAt - Date.now()),
			);
		}),
	]);
	if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
	return exitRace;
}

/**
 * Run one headless implementer dispatch against a real spawned child (never
 * an in-process mock). See the module header for the completion contract.
 */
export async function runHeadlessDispatch(opts: RunHeadlessDispatchOptions): Promise<HeadlessDispatchOutcome> {
	const idleBudgetMs = opts.idleBudgetMs ?? DEFAULT_HEADLESS_IDLE_BUDGET_MS;
	const tokenPollIntervalMs =
		opts.tokenCeilingProbe !== undefined ? Math.max(1, opts.tokenPollIntervalMs ?? 5_000) : undefined;
	// US-R1-006 (CAM-516): fixed wall-clock instant, computed once at dispatch
	// start. Never recomputed/reset as events arrive (that is precisely what
	// distinguishes it from idleBudgetMs above).
	const absoluteDeadlineAt =
		opts.absoluteTimeoutMs !== undefined ? Date.now() + opts.absoluteTimeoutMs : undefined;

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

	const streamOutcome = await consumeStdoutWithIdleBudget(
		proc.stdout,
		idleBudgetMs,
		absoluteDeadlineAt,
		opts.tokenCeilingProbe,
		tokenPollIntervalMs,
		onLine,
	);

	if (streamOutcome.kind === 'token-ceiling') {
		await terminateTimedOutChild(proc);
		return { kind: 'token-ceiling', tokenSpend: streamOutcome.tokenSpend, totalCostUsd };
	}

	if (streamOutcome.kind === 'idle-timeout' || streamOutcome.kind === 'absolute-timeout') {
		await terminateTimedOutChild(proc);
		return { kind: streamOutcome.kind, totalCostUsd };
	}

	const exitRace = await waitForExitBeforeAbsoluteDeadline(proc, absoluteDeadlineAt);
	if (exitRace.kind === 'absolute-timeout') {
		await terminateTimedOutChild(proc);
		return { kind: 'absolute-timeout', totalCostUsd };
	}

	return { kind: 'completed', exitCode: exitRace.exitCode, totalCostUsd };
}
