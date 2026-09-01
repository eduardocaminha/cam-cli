import { terminateProcessGroup } from './process-group.ts';

type AgentChild = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

export const DEFAULT_AGENT_ACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;

/** The child stayed alive without producing another provider-protocol line. */
export class AgentProcessActivityTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`Agent process produced no protocol activity for ${timeoutMs}ms.`);
		this.name = 'AgentProcessActivityTimeoutError';
	}
}

export interface AgentProcessInput {
	argv: string[];
	cwd: string;
	env: Record<string, string | undefined>;
	stdin: string;
	signal: AbortSignal;
	onLine: (line: string) => void;
	terminationGraceMs: number;
	/** Internal/test seam only. There is deliberately no operator setting. */
	activityTimeoutMs?: number;
	onSpawn?: (pid: number) => void;
}

export interface AgentProcessResult {
	exitCode: number;
	stderr: string;
}

async function consumeLines(
	stream: AgentChild['stdout'],
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

/** Shared process-group ownership for provider-specific JSONL protocols. */
export async function runAgentProcess(input: AgentProcessInput): Promise<AgentProcessResult> {
	const child = Bun.spawn({
		cmd: input.argv,
		cwd: input.cwd,
		env: input.env,
		detached: true,
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	input.onSpawn?.(child.pid);
	child.stdin.write(input.stdin);
	child.stdin.end();

	const activityTimeoutMs = input.activityTimeoutMs ?? DEFAULT_AGENT_ACTIVITY_TIMEOUT_MS;
	let activityTimer: ReturnType<typeof setTimeout> | undefined;
	let activityTimedOut = false;
	let termination: Promise<void> | undefined;
	const terminate = (): void => {
		termination ??= terminateProcessGroup(child, input.terminationGraceMs);
	};
	const armActivityTimer = (): void => {
		if (activityTimedOut) return;
		if (activityTimer !== undefined) clearTimeout(activityTimer);
		activityTimer = setTimeout(() => {
			activityTimedOut = true;
			terminate();
		}, activityTimeoutMs);
	};
	const stdout = consumeLines(child.stdout, (line) => {
		armActivityTimer();
		input.onLine(line);
	});
	const stderr = new Response(child.stderr).text();
	const abort = (): void => {
		terminate();
	};
	input.signal.addEventListener('abort', abort, { once: true });
	if (input.signal.aborted) abort();
	else armActivityTimer();

	try {
		const exited = child.exited.then((exitCode) => {
			if (activityTimer !== undefined) clearTimeout(activityTimer);
			activityTimer = undefined;
			return exitCode;
		});
		const [exitCode, stderrText] = await Promise.all([exited, stderr, stdout]);
		if (termination !== undefined) await termination;
		if (input.signal.aborted) throw new DOMException('cancelled', 'AbortError');
		if (activityTimedOut) throw new AgentProcessActivityTimeoutError(activityTimeoutMs);
		return { exitCode, stderr: stderrText };
	} finally {
		if (activityTimer !== undefined) clearTimeout(activityTimer);
		input.signal.removeEventListener('abort', abort);
	}
}
