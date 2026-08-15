const mode = process.env['GSHIP_FIXTURE_MODE'] ?? 'complete';
const input = await Bun.stdin.text();

process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);

if (mode === 'wait') {
	process.on('SIGTERM', () => process.exit(0));
	await new Promise(() => {});
} else if (mode === 'review') {
	// Stands in for a real reviewer child. FINDINGS echoes the argv the process
	// actually received, so a test can assert the read-only flag set reached a
	// real process instead of only the argv builder.
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
	process.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n`);
	process.stdout.write(`${JSON.stringify({
		type: 'result',
		is_error: false,
		result: JSON.stringify({ argv: process.argv.slice(2), input }),
	})}\n`);
}
