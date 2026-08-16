function fixtureArgument(name: string): string | undefined {
	const prefix = `--fixture-${name}=`;
	return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

const mode = fixtureArgument('mode') ?? 'complete';
const input = await Bun.stdin.text();

process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'codex-session-1' })}\n`);

if (mode === 'wait') {
	process.on('SIGTERM', () => process.exit(0));
	await new Promise(() => {});
} else if (mode === 'failed') {
	process.stdout.write(`${JSON.stringify({ type: 'turn.failed', error: { message: 'fixture failed' } })}\n`);
} else if (mode === 'structured-error-exit') {
	process.stdout.write(`${JSON.stringify({ type: 'error', message: 'structured fixture diagnostic' })}\n`);
	process.exitCode = 7;
} else {
	process.stdout.write(`${JSON.stringify({
		type: 'item.completed',
		item: { type: 'command_execution', command: '/not-persisted' },
	})}\n`);
	const status = mode === 'waiting-user' ? 'waiting-user' : 'completed';
	const verdict = fixtureArgument('verdict') ?? 'CLEAN';
	const output = mode === 'review'
		? {
			verdict,
			findings: verdict === 'CLEAN'
				? []
				: [{ file: 'src/reviewed.ts', summary: 'fixture finding' }],
		}
		: {
			status,
			summary: JSON.stringify({ argv: process.argv.slice(2), input }),
		};
	process.stdout.write(`${JSON.stringify({
		type: 'item.completed',
		item: {
			type: 'agent_message',
			text: JSON.stringify(output),
		},
	})}\n`);
	process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`);
}
