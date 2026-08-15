const mode = process.env['GSHIP_FIXTURE_MODE'] ?? 'complete';
const input = await Bun.stdin.text();

process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);

if (mode === 'wait') {
	process.on('SIGTERM', () => process.exit(0));
	await new Promise(() => {});
} else {
	process.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n`);
	process.stdout.write(`${JSON.stringify({
		type: 'result',
		is_error: false,
		result: JSON.stringify({ argv: process.argv.slice(2), input }),
	})}\n`);
}
