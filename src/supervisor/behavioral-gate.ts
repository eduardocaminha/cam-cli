// src/supervisor/behavioral-gate.ts
//
// Oracle parser (US-001) and behavioral gate runner (US-002) for CAM-116.
//
// US-001: parse per-story behavioral oracle directives from acceptance criteria.
// US-002: run a parsed oracle in a private-socket tmux session and assert it.
//
// Design:
//   - Parser: pure, no I/O, no side-effects.
//   - Gate runner: injectable spawnFn + socketName for isolation.
//     Default socket: BEHAVIORAL_GATE_SOCKET ('cam-behavioral-gate'), NEVER bare 'cam'.
//   - Mirrors parseReviewVerdict in src/supervisor/review.ts.
//   - noUncheckedIndexedAccess: all regex capture groups guarded via ?? ''.

// ---------------------------------------------------------------------------
// Oracle directive types
// ---------------------------------------------------------------------------

/**
 * A shell command that must exit 0 to satisfy the criterion.
 * Examples: "bun run typecheck", "bun test", "grep -q 'x' path/to/file".
 */
export interface NamedCommandOracle {
	kind: 'named-command';
	/** The exact shell command to run. */
	command: string;
}

/**
 * A file-level assertion command (file-assert prefix, payload is the command).
 * Examples: "git diff --quiet src/supervisor/review-report.ts".
 */
export interface FileAssertOracle {
	kind: 'file-assert';
	/** The shell command to run as the file-level assertion. */
	command: string;
}

/** A criterion that requires reviewer or human judgment. Use sparingly. */
export interface ReviewerJudgmentOracle {
	kind: 'reviewer-judgment';
}

/**
 * A tmux-pty driven criterion: the verification tool is tmux-pty and the
 * criterion names an artifact reference the tool produces/checks.
 */
export interface TmuxPtyOracle {
	kind: 'tmux-pty';
	/** Verification tool name -- always 'tmux-pty'. */
	toolName: 'tmux-pty';
	/** The artifact reference the criterion names. */
	artifactRef: string;
}

/**
 * Returned for a malformed or empty oracle text. Never throws -- an
 * unparseable oracle must not crash the gate (AC3).
 */
export interface NoRunnableOracle {
	kind: 'no-oracle';
	/** The raw oracle text that could not be classified. */
	raw: string;
}

/** Discriminated union of all possible oracle directive shapes. */
export type OracleDirective =
	| NamedCommandOracle
	| FileAssertOracle
	| ReviewerJudgmentOracle
	| TmuxPtyOracle
	| NoRunnableOracle;

/** One oracle-carrying criterion paired with its parsed directive. */
export interface CriterionOracle {
	/** Zero-based index of the criterion in the acceptanceCriteria array. */
	criterionIndex: number;
	/** The parsed oracle directive for this criterion. */
	directive: OracleDirective;
}

// ---------------------------------------------------------------------------
// Parser implementation
// ---------------------------------------------------------------------------

/**
 * Matches the LAST [oracle: ...] suffix on a criterion string.
 * The leading `.*` is greedy: it consumes as much as possible so that
 * `\[oracle:` anchors to the LAST occurrence in the string (important when
 * the criterion text also mentions [oracle: ...] as an example in prose).
 * Capture group 1: the trimmed oracle text (may be empty for "[oracle: ]").
 * The suffix may be followed only by optional whitespace at end of string.
 */
const ORACLE_SUFFIX_RE = /.*\[oracle:\s*(.*?)\s*\]\s*$/;

/**
 * Classify the inner oracle text into a typed OracleDirective.
 */
function classifyOracleText(raw: string): OracleDirective {
	if (raw === '') {
		return { kind: 'no-oracle', raw };
	}

	if (raw === 'reviewer-judgment') {
		return { kind: 'reviewer-judgment' };
	}

	if (raw.startsWith('file-assert ')) {
		const command = raw.slice('file-assert '.length).trim();
		if (command === '') {
			return { kind: 'no-oracle', raw };
		}
		return { kind: 'file-assert', command };
	}

	if (raw.startsWith('tmux-pty ')) {
		const artifactRef = raw.slice('tmux-pty '.length).trim();
		if (artifactRef === '') {
			return { kind: 'no-oracle', raw };
		}
		return { kind: 'tmux-pty', toolName: 'tmux-pty', artifactRef };
	}

	// Everything else is a named-command (exact shell command to run).
	return { kind: 'named-command', command: raw };
}

/**
 * Extract and parse the [oracle: ...] directive from one acceptance criterion.
 *
 * Returns null when the criterion carries no [oracle: ...] suffix (criteria
 * without an oracle yield no directive per AC1).
 *
 * Returns a NoRunnableOracle when the suffix is present but the oracle text is
 * malformed or empty (graceful -- never throws, per AC3).
 */
export function parseOracleDirective(criterion: string): OracleDirective | null {
	const m = ORACLE_SUFFIX_RE.exec(criterion);
	if (m === null) return null;

	const raw = m[1] ?? '';
	return classifyOracleText(raw);
}

/**
 * Parse all [oracle: ...] directives from a PRD story's acceptanceCriteria.
 *
 * Returns one CriterionOracle per criterion that carries an [oracle: ...] suffix.
 * Criteria without a suffix are skipped (yield no entry in the result).
 * Malformed oracle text yields { kind: 'no-oracle' } rather than throwing.
 *
 * @param criteria - The acceptanceCriteria array from a PRD story record.
 * @returns Ordered list of criterion index + directive pairs.
 */
export function parseOracleDirectives(criteria: string[]): CriterionOracle[] {
	const results: CriterionOracle[] = [];

	for (let i = 0; i < criteria.length; i++) {
		const criterion = criteria[i];
		if (criterion === undefined) continue;

		const directive = parseOracleDirective(criterion);
		if (directive !== null) {
			results.push({ criterionIndex: i, directive });
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Behavioral gate runner (US-002, CAM-116)
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import type { SpawnFn } from '../tmux/session.ts';

/**
 * Default private tmux socket name for the behavioral gate.
 * NEVER bare 'cam': isolation guard prevents touching the live cam session.
 */
export const BEHAVIORAL_GATE_SOCKET = 'cam-behavioral-gate';

/** Marker string appended to commands to detect exit-code in pane text. */
const EXIT_MARKER = 'CAMGATE';
/** Regex to extract the exit code from the marker echo. */
const EXIT_MARKER_RE = /CAMGATE_(\d+)/;

/** Result returned by runBehavioralGate. */
export interface BehavioralGateResult {
	/** True when the oracle command exited 0. */
	passed: boolean;
	/**
	 * Raw text of the captured tmux pane at gate completion time.
	 * The caller may persist this as an artifact for diagnostics.
	 */
	capturedPane: string;
	/** Human-readable detail about the gate outcome. */
	detail: string;
}

/** Options for runBehavioralGate. All fields are optional / injectable. */
export interface RunBehavioralGateOpts {
	/**
	 * Injectable spawn function; defaults to a spawnSync-backed shim.
	 * Inject in tests to assert exact tmux argv without hitting a real server.
	 */
	spawnFn?: SpawnFn;
	/**
	 * tmux socket name. Defaults to BEHAVIORAL_GATE_SOCKET.
	 * NEVER 'cam': must not touch the live cam orchestrator session.
	 */
	socketName?: string;
	/** Working directory for the tmux session. Defaults to process.cwd(). */
	cwd?: string;
	/** Max ms to wait for the oracle command to complete. Defaults to 30_000. */
	timeoutMs?: number;
}

function makeDefaultSpawnFn(): SpawnFn {
	return (cmd, args, opts) =>
		spawnSync(cmd, args, {
			stdio: opts?.stdio ?? 'pipe',
			encoding: 'buffer',
		}) as ReturnType<SpawnFn>;
}

/**
 * Return a non-null BehavioralGateResult for oracle kinds that cannot be run
 * autonomously, or null when the directive IS runnable (named-command / file-assert).
 *
 * Extracted to keep runBehavioralGate below the cognitive-complexity limit.
 */
function resolveNonRunnableResult(directive: OracleDirective): BehavioralGateResult | null {
	if (directive.kind === 'reviewer-judgment') {
		return {
			passed: false,
			capturedPane: '',
			detail: 'oracle kind reviewer-judgment is not autonomously runnable',
		};
	}
	if (directive.kind === 'no-oracle') {
		return {
			passed: false,
			capturedPane: '',
			detail: `oracle kind no-oracle is not runnable (raw: ${directive.raw})`,
		};
	}
	if (directive.kind === 'tmux-pty') {
		return {
			passed: false,
			capturedPane: '',
			detail: `oracle kind tmux-pty requires external verification (artifactRef: ${directive.artifactRef})`,
		};
	}
	return null;
}

/**
 * Poll capture-pane until the exit-code marker appears or the deadline passes.
 *
 * Returns { exitCode, capturedPane }. exitCode is null on timeout.
 *
 * Extracted to keep runBehavioralGate below the cognitive-complexity limit.
 */
function pollForExitCode(
	spawn: SpawnFn,
	socketName: string,
	sessionName: string,
	timeoutMs: number,
): { exitCode: number | null; capturedPane: string } {
	const deadline = Date.now() + timeoutMs;
	let capturedPane = '';
	let exitCode: number | null = null;

	while (Date.now() < deadline) {
		Bun.sleepSync(300);
		const r = spawn(
			'tmux',
			['-L', socketName, 'capture-pane', '-p', '-t', sessionName],
			{ stdio: 'pipe' },
		);
		capturedPane = String(r.stdout ?? '');
		const m = EXIT_MARKER_RE.exec(capturedPane);
		if (m !== null) {
			exitCode = parseInt(m[1] ?? '1', 10);
			break;
		}
	}

	return { exitCode, capturedPane };
}

/**
 * Run a single OracleDirective against a real tmux session on a private socket.
 *
 * Flow:
 *   1. Create a fresh tmux session on the private socket (-L socketName).
 *   2. Send the oracle command followed by an exit-code marker echo.
 *   3. Poll capture-pane until the marker appears or timeout elapses.
 *   4. Kill the session (always, via finally).
 *   5. Return { passed, capturedPane, detail }.
 *
 * Non-runnable oracles (reviewer-judgment, no-oracle, tmux-pty) return
 * passed:false immediately with an explanatory detail string.
 *
 * Isolation guarantee: the socket is injectable and defaults to
 * BEHAVIORAL_GATE_SOCKET, so the gate never spawns on the live 'cam' socket.
 */
export function runBehavioralGate(
	directive: OracleDirective,
	opts: RunBehavioralGateOpts = {},
): BehavioralGateResult {
	const socketName = opts.socketName ?? BEHAVIORAL_GATE_SOCKET;
	const spawn = opts.spawnFn ?? makeDefaultSpawnFn();
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const cwd = opts.cwd ?? process.cwd();

	const nonRunnable = resolveNonRunnableResult(directive);
	if (nonRunnable !== null) return nonRunnable;

	// After the resolveNonRunnableResult guard, directive is named-command or
	// file-assert; both expose a .command field. The cast is safe by invariant.
	const command = (directive as NamedCommandOracle | FileAssertOracle).command;
	const sessionName = `cam-gate-${Date.now()}`;

	const newSessionResult = spawn(
		'tmux',
		['-L', socketName, 'new-session', '-d', '-s', sessionName, '-x', '220', '-y', '50', '-c', cwd],
		{ stdio: 'ignore' },
	);
	if ((newSessionResult.status ?? 1) !== 0) {
		return {
			passed: false,
			capturedPane: '',
			detail: 'failed to create tmux session for behavioral gate',
		};
	}

	try {
		// Append exit-code marker so polling can detect command completion.
		spawn(
			'tmux',
			['-L', socketName, 'send-keys', '-t', sessionName, `${command}; echo "${EXIT_MARKER}_$?"`, 'Enter'],
			{ stdio: 'ignore' },
		);

		const { exitCode, capturedPane } = pollForExitCode(spawn, socketName, sessionName, timeoutMs);

		if (exitCode === null) {
			return {
				passed: false,
				capturedPane,
				detail: `timeout after ${timeoutMs}ms waiting for oracle command to complete`,
			};
		}

		return {
			passed: exitCode === 0,
			capturedPane,
			detail: exitCode === 0 ? 'oracle command exited 0' : `oracle command exited ${exitCode}`,
		};
	} finally {
		spawn('tmux', ['-L', socketName, 'kill-session', '-t', sessionName], { stdio: 'ignore' });
	}
}
