import { terminateProcessGroup } from './process-group.ts';

type AgentChild = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

export interface AgentProcessInput {
	argv: string[];
	cwd: string;
	env: Record<string, string | undefined>;
	stdin: string;
	signal: AbortSignal;
	onLine: (line: string) => void;
	terminationGraceMs: number;
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

	const stdout = consumeLines(child.stdout, input.onLine);
	const stderr = new Response(child.stderr).text();
	let termination: Promise<void> | undefined;
	const abort = (): void => {
		termination ??= terminateProcessGroup(child, input.terminationGraceMs);
	};
	input.signal.addEventListener('abort', abort, { once: true });
	if (input.signal.aborted) abort();

	try {
		const [exitCode, stderrText] = await Promise.all([child.exited, stderr, stdout]);
		if (termination !== undefined) await termination;
		if (input.signal.aborted) throw new DOMException('cancelled', 'AbortError');
		return { exitCode, stderr: stderrText };
	} finally {
		input.signal.removeEventListener('abort', abort);
	}
}
