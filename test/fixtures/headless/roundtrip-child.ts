// test/fixtures/headless/roundtrip-child.ts
//
// Real spawnable stand-in for `claude --print --input-format stream-json
// --output-format stream-json --verbose`, used by
// test/integration/headless-roundtrip.test.ts (US-007, CAM-516).
//
// Unlike test/fixtures/headless/fixture-child.ts (US-003's narrower
// dispatch-machinery-only proof: stdin/stdout/idle-budget wiring against an
// arbitrary cwd), this fixture ALSO performs the real git side of one
// implementer dispatch -- an empty commit plus a push to `origin` -- inside
// its own cwd (set by the parent's `Bun.spawn({ cwd })`, i.e. the scratch
// working clone the round-trip test wires up). That is the whole point of
// this story (issue AC3): a fixture standing in for the MODEL still has to
// exercise the real GIT wire, since the acceptance criteria are about
// proving the seam's git boundary with observed I/O, not the model.
//
// Usage: `bun roundtrip-child.ts <commit message>`

const commitMessage = process.argv[2];
if (!commitMessage) {
	throw new Error('roundtrip-child.ts: commit message argv[2] is required');
}

function emit(obj: unknown): void {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function git(args: string[]): void {
	const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr);
		throw new Error(`git ${args.join(' ')} failed (exit ${result.exitCode}): ${stderr}`);
	}
}

process.stdin.resume();
process.stdin.on('data', () => {});

process.stdin.on('end', () => {
	emit({ type: 'system', subtype: 'init', isTTY: process.stdout.isTTY === true });
	emit({
		type: 'assistant',
		message: { content: [{ type: 'text', text: 'fixture: committing and pushing the round-trip commit' }] },
	});

	// The real git side of the round trip: an empty commit (no file changes
	// needed to prove a real commit object lands on the remote) plus a push to
	// `origin`, both run against `process.cwd()` -- the scratch working clone
	// the parent process spawned this fixture into.
	git(['commit', '--allow-empty', '-m', commitMessage]);
	git(['push', 'origin', 'HEAD:main']);

	emit({ type: 'result', subtype: 'success', total_cost_usd: 0.0789, session_id: 'roundtrip-fixture-session' });
	process.exit(0);
});
