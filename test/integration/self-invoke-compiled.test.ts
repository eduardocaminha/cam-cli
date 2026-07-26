// test/integration/self-invoke-compiled.test.ts
//
// Integration test (REAL bun build --compile): pins the `/$bunfs/` compiled
// self-invoke premise that resolveSelfInvokeArgv (src/util/self-invoke.ts,
// US-001/US-002, CAM-425/CAM-426) keys its detection on.
//
// Every prior test of this bug class (test/commands/run-orch-resolver-compiled-mode.test.ts,
// test/retry/interactive.test.ts) proves the branching logic by MONKEYPATCHING
// process.execPath/process.argv[1] to simulate a compiled invocation. That is
// correct for pinning the pure function, but it never actually runs `bun
// build --compile` and never proves bun's real `/$bunfs/root/<outfile>` argv1
// shape still holds. This test closes that gap empirically, repo-wide: it
// compiles a real fixture, runs the real binary, and round-trips a marker
// token through a real self-spawned child -- so a future bun release that
// changes the `/$bunfs/` prefix (or the argv slot the self-spawned marker
// lands in) fails this test loudly instead of silently killing every
// self-spawned child in production (forkMonitor, the orch-resolve respawn).
//
// Fixture design: a single fixture script plays BOTH roles. On its initial
// invocation (compiled binary run directly, or `bun fixture.ts`), argv[2] is
// always absent -- neither mode ever produces a 3rd argv slot on a bare
// invocation (compiled: [runtime, /$bunfs/ virtual entry]; interpreted:
// [bunPath, scriptPath]). It then self-spawns itself via
// `[...resolveSelfInvokeArgv(execPath, argv1), markerToken]` -- the exact
// production shape used by forkMonitor and the orch-resolve respawn -- and
// the spawned child observes the marker at argv[2] in BOTH modes (compiled:
// the self-spawn's single extra token fills the child's 3rd slot the same
// way the virtual entry fills its 2nd; interpreted: the self-spawn passes
// both runtime+script tokens ahead of the marker). Presence of argv[2] is
// therefore what the fixture uses to tell "am I the initial run or the
// self-spawned child" apart.
//
// CAM-407 leak-class discipline: `bun build --compile` drops a `.bun-build`
// scratch file INTO ITS OWN CWD (verified empirically: it does NOT follow the
// outfile's or the source's directory), so the build call below runs with
// `cwd` pinned to the same tmpdir the compiled binary and fixture source live
// in. `afterEach` removes that whole tmpdir -- fixture source, outfile, AND
// the `.bun-build` scratch file -- even when a test throws, closing the exact
// leak class CAM-407 documents.
//
// CAM-424: this file has no conditional test-skip guard of any kind.
// `bun build --compile` unavailability is not tolerated as a skip condition
// -- it fails the build step loudly (thrown Error surfacing the compiler's
// real stderr) rather than silently reporting green.

import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Tmp-dir lifecycle
// ---------------------------------------------------------------------------

const dirsToCleanup: string[] = [];

afterEach(() => {
	for (const dir of dirsToCleanup) {
		rmSync(dir, { recursive: true, force: true });
	}
	dirsToCleanup.length = 0;
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const SELF_INVOKE_SRC = join(import.meta.dir, '..', '..', 'src', 'util', 'self-invoke.ts');

/** Writes the shared fixture entry into `dir` and returns its path. */
function writeFixture(dir: string): string {
	const fixturePath = join(dir, 'fixture.ts');
	const source = `import { resolveSelfInvokeArgv } from ${JSON.stringify(SELF_INVOKE_SRC)};

const inheritedMarker = process.argv[2];

if (inheritedMarker !== undefined) {
	console.log(JSON.stringify({ role: 'child', argv2: inheritedMarker }));
} else {
	const markerToken = 'us003-marker-' + Math.random().toString(36).slice(2);
	const spawnArgv = [...resolveSelfInvokeArgv(process.execPath, process.argv[1]), markerToken];
	const child = Bun.spawnSync(spawnArgv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
	console.log(
		JSON.stringify({
			role: 'parent',
			argv1: process.argv[1] ?? null,
			markerToken,
			childExitCode: child.exitCode,
			childStdout: child.stdout.toString('utf8').trim(),
			childStderr: child.stderr.toString('utf8').trim(),
		}),
	);
}
`;
	writeFileSync(fixturePath, source, 'utf8');
	return fixturePath;
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

interface ParentOutput {
	role: string;
	argv1: string | null;
	markerToken: string;
	childExitCode: number;
	childStdout: string;
	childStderr: string;
}

function parseParentOutput(stdout: string): ParentOutput {
	const lastLine = stdout.trim().split('\n').pop() ?? '';
	return JSON.parse(lastLine) as ParentOutput;
}

/** Asserts the self-spawned child observed the parent's marker token at argv[2]. */
function assertChildSawMarker(parentOutput: ParentOutput): void {
	expect(parentOutput.role).toBe('parent');
	expect(parentOutput.childExitCode).toBe(0);
	const child = JSON.parse(parentOutput.childStdout) as { role: string; argv2: string };
	expect(child.role).toBe('child');
	expect(child.argv2).toBe(parentOutput.markerToken);
}

// ---------------------------------------------------------------------------
// Tests
//
// `stdin: 'ignore'` is required on every spawnSync here (both the outer
// build/run calls and the fixture's own inner self-spawn baked into the
// generated source above): under a plain `bun` script a nested spawnSync
// chain (test -> compiled binary -> self-spawned child) inherits stdio fine,
// but under `bun test`'s own process it hangs past the default 5s test
// timeout without an explicit `stdin: 'ignore'` at every level (verified
// empirically while developing this test). None of these processes read
// stdin, so ignoring it is also the semantically correct choice, not a
// mask over a real behavior difference under test.
//
// `realpathSync` on the expected interpreted argv1 accounts for macOS's
// `/var` -> `/private/var` symlink: `mkdtempSync(join(tmpdir(), ...))`
// returns the `/var/...` alias, but bun resolves argv1 to the real,
// symlink-resolved path.
// ---------------------------------------------------------------------------

test(
	'compiled binary: process.argv[1] starts with /$bunfs/, and the self-spawned child observes the marker at argv[2]',
	() => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-self-invoke-compiled-'));
		dirsToCleanup.push(dir);

		writeFixture(dir);
		const binPath = join(dir, 'fixture-bin');

		const build = Bun.spawnSync(['bun', 'build', '--compile', './fixture.ts', '--outfile', './fixture-bin'], {
			cwd: dir,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		if (build.exitCode !== 0) {
			throw new Error(`bun build --compile failed (exit ${build.exitCode}): ${build.stderr.toString('utf8')}`);
		}

		const run = Bun.spawnSync([binPath], { cwd: dir, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
		expect(run.exitCode).toBe(0);

		const parentOutput = parseParentOutput(run.stdout.toString('utf8'));
		expect(parentOutput.argv1).not.toBeNull();
		expect((parentOutput.argv1 as string).startsWith('/$bunfs/')).toBe(true);
		assertChildSawMarker(parentOutput);
	},
	{ timeout: 30_000 },
);

test(
	'interpreted fixture: the self-spawned child observes the marker at argv[2]',
	() => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-self-invoke-interpreted-'));
		dirsToCleanup.push(dir);

		const fixturePath = writeFixture(dir);

		const run = Bun.spawnSync(['bun', fixturePath], { cwd: dir, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
		expect(run.exitCode).toBe(0);

		const parentOutput = parseParentOutput(run.stdout.toString('utf8'));
		expect(parentOutput.argv1).toBe(realpathSync(fixturePath));
		assertChildSawMarker(parentOutput);
	},
	{ timeout: 30_000 },
);
