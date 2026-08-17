function fixtureArgument(name: string): string | undefined {
	const prefix = `--fixture-${name}=`;
	return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

const mode = fixtureArgument('mode') ?? 'complete';
const input = await Bun.stdin.text();

process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);

if (mode === 'wait') {
	process.on('SIGTERM', () => process.exit(0));
	await new Promise(() => {});
} else if (mode === 'review') {
	const verdict = fixtureArgument('verdict') ?? 'CLEAN';
	process.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n`);
	process.stdout.write(`${JSON.stringify({
		type: 'result',
		is_error: false,
		result: JSON.stringify({
			verdict,
			findings: verdict === 'CLEAN'
				? []
				: [{ file: 'src/reviewed.ts', summary: `argv: ${JSON.stringify(process.argv.slice(2))}` }],
		}),
	})}\n`);
} else {
	const summary = JSON.stringify({ argv: process.argv.slice(2), input });
	const status = mode === 'waiting-user' ? 'waiting-user' : 'completed';
	process.stdout.write(`${JSON.stringify({
		type: 'assistant',
		message: {
			content: [
				{ type: 'text', text: 'fixture activity' },
				{ type: 'tool_use', name: 'Read', input: { file_path: '/not-persisted' } },
			],
		},
	})}\n`);
	const proposal = fixtureArgument('proposal');
	process.stdout.write(`${JSON.stringify({
		type: 'result',
		is_error: false,
		result: summary,
		structured_output: {
			status,
			summary,
			proposals: proposal === undefined
				? []
				: [{ title: proposal, evidence: 'fixture evidence' }],
		},
	})}\n`);
}
