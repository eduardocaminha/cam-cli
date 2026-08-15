import { spawnSync } from 'node:child_process';

import type {
	FileAssertOracle,
	NamedCommandOracle,
	OracleDirective,
} from '../issues/oracle-directive.ts';
import type { SpawnFn } from '../tmux/session.ts';

export {
	parseOracleDirective,
	parseOracleDirectives,
	type CriterionOracle,
	type FileAssertOracle,
	type MalformedOracle,
	type NamedCommandOracle,
	type NoRunnableOracle,
	type OracleDirective,
	type ReviewerJudgmentOracle,
	type TmuxPtyOracle,
} from '../issues/oracle-directive.ts';

export const BEHAVIORAL_GATE_SOCKET = 'cam-behavioral-gate';

const EXIT_MARKER = 'CAMGATE';
const EXIT_MARKER_RE = /CAMGATE_(\d+)/;

export interface BehavioralGateResult {
	passed: boolean;
	capturedPane: string;
	detail: string;
}

export interface RunBehavioralGateOpts {
	spawnFn?: SpawnFn;
	socketName?: string;
	cwd?: string;
	timeoutMs?: number;
}

function makeDefaultSpawnFn(): SpawnFn {
	return (cmd, args, opts) =>
		spawnSync(cmd, args, {
			stdio: opts?.stdio ?? 'pipe',
			encoding: 'buffer',
		}) as ReturnType<SpawnFn>;
}

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
	if (directive.kind === 'malformed') {
		return {
			passed: false,
			capturedPane: '',
			detail: `oracle kind malformed is not runnable (unterminated oracle mark, raw: ${directive.raw})`,
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
		const result = spawn(
			'tmux',
			['-L', socketName, 'capture-pane', '-p', '-t', sessionName],
			{ stdio: 'pipe' },
		);
		capturedPane = String(result.stdout ?? '');
		const match = EXIT_MARKER_RE.exec(capturedPane);
		if (match !== null) {
			exitCode = Number.parseInt(match[1] ?? '1', 10);
			break;
		}
	}

	return { exitCode, capturedPane };
}

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

	const command = (directive as NamedCommandOracle | FileAssertOracle).command;
	const sessionName = `cam-gate-${Date.now()}`;
	const created = spawn(
		'tmux',
		['-L', socketName, 'new-session', '-d', '-s', sessionName, '-x', '220', '-y', '50', '-c', cwd],
		{ stdio: 'ignore' },
	);
	if ((created.status ?? 1) !== 0) {
		return {
			passed: false,
			capturedPane: '',
			detail: 'failed to create tmux session for behavioral gate',
		};
	}

	try {
		spawn(
			'tmux',
			['-L', socketName, 'send-keys', '-t', sessionName, `${command}; echo "${EXIT_MARKER}_$?"`, 'Enter'],
			{ stdio: 'ignore' },
		);
		const { exitCode, capturedPane } = pollForExitCode(
			spawn,
			socketName,
			sessionName,
			timeoutMs,
		);
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
