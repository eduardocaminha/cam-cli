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
} else if (mode === 'error') {
	// Echoes the probed model/effort back in a turn.failed event, so a test can
	// confirm the probe's argv actually carried the chosen slot.
	const modelIndex = process.argv.indexOf('-m');
	const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : undefined;
	const effortArg = process.argv.find((argument) => argument.startsWith('model_reasoning_effort='));
	process.stdout.write(`${JSON.stringify({
		type: 'turn.failed',
		error: { message: `model "${model}" effort ${effortArg ?? '(none)'} not found` },
	})}\n`);
} else if (mode === 'structured-error-exit') {
	process.stdout.write(`${JSON.stringify({ type: 'error', message: 'structured fixture diagnostic' })}\n`);
	process.exitCode = 7;
} else if (mode === 'usage-limit') {
	process.stdout.write(`${JSON.stringify({
		type: 'turn.failed',
		error: { message: 'You have hit your usage limit. Try again later.' },
	})}\n`);
} else {
	process.stdout.write(`${JSON.stringify({
		type: 'item.completed',
		item: { type: 'command_execution', command: '/not-persisted' },
	})}\n`);
	const status = mode === 'waiting-user' ? 'waiting-user' : 'completed';
	const verdict = fixtureArgument('verdict') ?? 'CLEAN';
	const proposal = fixtureArgument('proposal');
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
			proposals: proposal === undefined
				? []
				: [{ title: proposal, evidence: 'fixture evidence' }],
			reconciliation: {
				outcome: status === 'waiting-user' ? 'contract-change-required' : 'unchanged',
				summary: 'fixture reconciliation',
			},
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
