// test/fixtures/headless/fixture-child.ts
//
// Real spawnable stand-in for `claude --print --input-format stream-json
// --output-format stream-json --verbose`, used by
// test/supervisor/headless-dispatch.test.ts (US-003, CAM-516). A REAL
// subprocess (not an in-process mock), so the dispatch runner under test
// exercises the actual `Bun.spawn` boundary: a real stdin FileSink, real
// NDJSON stdout, real exit/signal handling. Mirrors the fixture-executable
// pattern established by test/fixtures/interactivity/mock-claude.ts and
// test/fixtures/dispatch-geometry/raw-echo.ts.
//
// Usage: `bun fixture-child.ts <happy|idle>`
//
//   happy - drains stdin (the stream-json input message) to EOF, then emits
//           a system/init line (reporting `process.stdout.isTTY` so the "no
//           TTY is allocated" test can assert on it from inside the real
//           child, not the parent), an assistant line, and a result line
//           carrying `total_cost_usd`, then exits 0.
//   idle  - drains stdin to EOF, emits ONE system/init line, then goes
//           silent forever: it never exits on its own. The "idle budget"
//           test proves the dispatch runner kills it once its idle budget
//           elapses. On SIGTERM it exits 143, mirroring the documented
//           abort-turn behavior of the real CLI (officialDocsValidated pin
//           on this story, code.claude.com/docs/en/headless).

const mode = process.argv[2] === 'idle' ? 'idle' : 'happy';

function emit(obj: unknown): void {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

process.on('SIGTERM', () => {
	process.exit(143);
});

// Drain stdin (the stream-json input message) without acting on its
// content -- this fixture's behavior is fully argv-driven.
process.stdin.resume();
process.stdin.on('data', () => {});

process.stdin.on('end', () => {
	emit({ type: 'system', subtype: 'init', isTTY: process.stdout.isTTY === true });

	if (mode === 'idle') {
		// Deliberately never exits on its own: the parent must kill it once
		// its idle budget elapses. Without a pending handle, the event loop
		// would otherwise drain to empty right after the `stdin.on('end', ...)`
		// callback returns (both Node and Bun exit naturally once there is no
		// more scheduled work) — a long-lived, never-firing interval is the
		// pending handle that keeps this process genuinely alive until SIGTERM.
		setInterval(() => {}, 1_000_000);
		return;
	}

	emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'fixture reply' }] } });
	emit({ type: 'result', subtype: 'success', total_cost_usd: 0.0456, session_id: 'fixture-session' });
	process.exit(0);
});
