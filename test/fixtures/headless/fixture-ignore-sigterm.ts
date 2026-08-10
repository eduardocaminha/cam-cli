// Real child fixture that deliberately ignores SIGTERM. It exits naturally
// after two seconds only as test-process cleanup defense; the dispatch runner
// must escalate to SIGKILL well before then.

process.on('SIGTERM', () => {
	// Deliberately ignore the cooperative termination request.
});

process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
	process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);
	setTimeout(() => process.exit(0), 2_000);
});
