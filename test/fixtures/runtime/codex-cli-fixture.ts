const mode = process.env['GSHIP_FIXTURE_MODE'] ?? 'complete';
const input = await Bun.stdin.text();

process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'codex-session-1' })}\n`);

if (mode === 'wait') {
	process.on('SIGTERM', () => process.exit(0));
	await new Promise(() => {});
} else if (mode === 'failed') {
	process.stdout.write(`${JSON.stringify({ type: 'turn.failed', error: { message: 'fixture failed' } })}\n`);
} else {
	process.stdout.write(`${JSON.stringify({
		type: 'item.completed',
		item: { type: 'command_execution', command: '/not-persisted' },
	})}\n`);
	const status = mode === 'waiting-user' ? 'waiting-user' : 'completed';
	const verdict = process.env['GSHIP_FIXTURE_VERDICT'] ?? 'CLEAN';
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
