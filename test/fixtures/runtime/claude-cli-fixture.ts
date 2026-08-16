const mode = process.env['GSHIP_FIXTURE_MODE'] ?? 'complete';
const input = await Bun.stdin.text();

process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);

if (mode === 'wait') {
	process.on('SIGTERM', () => process.exit(0));
	await new Promise(() => {});
} else if (mode === 'review') {
	const verdict = process.env['GSHIP_FIXTURE_VERDICT'] ?? 'CLEAN';
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
	process.stdout.write(`${JSON.stringify({
		type: 'result',
		is_error: false,
		result: summary,
		structured_output: { status, summary },
	})}\n`);
}
