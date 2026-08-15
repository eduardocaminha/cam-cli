import process from 'node:process';

import { getIssueOnMain } from '../commands/issue-get.ts';
import { classifyHeadlessStreamLine } from '../supervisor/headless-stream.ts';
import type {
	RuntimeExecutionInput,
	RuntimeExecutionResult,
	RuntimeExecutor,
} from './run-runtime.ts';
import { terminateProcessGroup } from './process-group.ts';

const CLAUDE_NESTING_ENV = [
	'CLAUDECODE',
	'CLAUDE_CODE_ENTRYPOINT',
	'CLAUDE_CODE_SESSION_ID',
	'CLAUDE_CODE_SSE_PORT',
	'CLAUDE_CODE_EXECPATH',
	'CLAUDE_AGENT_SDK_VERSION',
] as const;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;

export interface ClaudeCliExecutorOptions {
	command?: string[];
	model?: string;
	permissionMode?: string;
	sourceEnv?: Record<string, string | undefined>;
	terminationGraceMs?: number;
	loadIssue?: (cwd: string, issueId: string) => string;
	onSpawn?: (pid: number) => void;
}

interface ClaudeInvocation {
	command: string[];
	sessionId: string;
	resume: boolean;
	permissionMode: string;
	model?: string;
}

type ClaudeChild = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

function buildClaudeEnv(
	source: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const env = { ...source };
	for (const key of CLAUDE_NESTING_ENV) delete env[key];
	delete env.ANTHROPIC_API_KEY;
	delete env.CLAUDE_CODE_OAUTH_TOKEN;
	delete env.TMUX;
	delete env.TMUX_PANE;
	return env;
}

export function buildClaudeCliArgv(input: ClaudeInvocation): string[] {
	const argv = [
		...input.command,
		'--print',
		'--input-format',
		'stream-json',
		'--output-format',
		'stream-json',
		'--verbose',
		'--permission-mode',
		input.permissionMode,
	];
	argv.push(input.resume ? '--resume' : '--session-id', input.sessionId.toLowerCase());
	if (input.model !== undefined) argv.push('--model', input.model);
	return argv;
}

function defaultLoadIssue(cwd: string, issueId: string): string {
	const issue = getIssueOnMain(cwd, issueId);
	if (!issue.ok) throw new Error(`issue not found on main: ${issueId}`);
	return issue.content;
}

function buildWorkPrompt(issueId: string, issue: string, resume: boolean): string {
	return [
		resume
			? `Continue the existing Gateship work session for ${issueId}.`
			: `Implement Gateship issue ${issueId}.`,
		'Inspect the current working tree before editing and keep the change limited to this issue.',
		'Do not commit, push, merge, ship, or edit issue/runtime control state; the Gateship service owns lifecycle.',
		'Run focused tests for the changed surface. The service will perform independent verification afterward.',
		'If a user decision is required, stop editing and explain the exact decision in your final result.',
		'',
		'Issue record:',
		issue,
	].join('\n');
}

function spawnClaude(
	argv: string[],
	cwd: string,
	env: Record<string, string | undefined>,
): ClaudeChild {
	return Bun.spawn({
		cmd: argv,
		cwd,
		env,
		detached: true,
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	});
}

async function consumeLines(
	stream: ClaudeChild['stdout'],
	onLine: (line: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		buffer += decoder.decode(chunk.value, { stream: true });
		let newline = buffer.indexOf('\n');
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.length > 0) onLine(line);
			newline = buffer.indexOf('\n');
		}
	}
	buffer += decoder.decode();
	if (buffer.length > 0) onLine(buffer);
}

export class ClaudeCliExecutor implements RuntimeExecutor {
	readonly #options: ClaudeCliExecutorOptions;

	constructor(options: ClaudeCliExecutorOptions = {}) {
		this.#options = options;
	}

	async execute(input: RuntimeExecutionInput): Promise<RuntimeExecutionResult> {
		const issue = (this.#options.loadIssue ?? defaultLoadIssue)(input.cwd, input.issueId);
		const prompt = buildWorkPrompt(input.issueId, issue, input.resume);
		const argv = buildClaudeCliArgv({
			command: this.#options.command ?? ['claude'],
			sessionId: input.sessionId,
			resume: input.resume,
			permissionMode: this.#options.permissionMode ?? 'bypassPermissions',
			...(this.#options.model === undefined ? {} : { model: this.#options.model }),
		});
		const child = spawnClaude(
			argv,
			input.cwd,
			buildClaudeEnv(this.#options.sourceEnv ?? process.env),
		);
		this.#options.onSpawn?.(child.pid);

		const message = JSON.stringify({
			type: 'user',
			message: { role: 'user', content: prompt },
		});
		child.stdin.write(`${message}\n`);
		child.stdin.end();

		let resultSeen = false;
		let resultIsError = false;
		let summary = '';
		const stdout = consumeLines(child.stdout, (line) => {
			const event = classifyHeadlessStreamLine(line);
			if (event.kind === 'system') {
				input.emit('provider.system', { subtype: event.subtype ?? 'unknown' });
			} else if (event.kind === 'assistant') {
				input.emit('provider.activity');
			} else if (event.kind === 'rate_limit_event') {
				input.emit('provider.rate-limit');
			} else if (event.kind === 'result') {
				resultSeen = true;
				resultIsError = event.raw.is_error === true;
				if (typeof event.raw.result === 'string') summary = event.raw.result;
				input.emit('provider.result');
			}
		});
		const stderr = new Response(child.stderr).text();
		let termination: Promise<void> | undefined;
		const abort = (): void => {
			termination ??= terminateProcessGroup(
				child,
				this.#options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
			);
		};
		input.signal.addEventListener('abort', abort, { once: true });
		if (input.signal.aborted) abort();

		try {
			const [exitCode, stderrText] = await Promise.all([child.exited, stderr, stdout]);
			if (termination !== undefined) await termination;
			if (input.signal.aborted) throw new DOMException('cancelled', 'AbortError');
			if (exitCode !== 0) {
				throw new Error(`Claude CLI exited with ${exitCode}: ${stderrText.trim().slice(-1_000)}`);
			}
			if (!resultSeen) throw new Error('Claude CLI exited without a result event.');
			if (resultIsError) throw new Error(summary || 'Claude CLI returned an error result.');
			return { outcome: 'completed', ...(summary.length === 0 ? {} : { summary }) };
		} finally {
			input.signal.removeEventListener('abort', abort);
		}
	}
}
