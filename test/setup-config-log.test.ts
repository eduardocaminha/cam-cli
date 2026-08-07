// test/setup-config-log.test.ts
//
// Behavioral proof for the CAM-510 site 4 fix: `cam setup`'s config-pane
// debug log used to be the fixed, shared, unbounded path
// `/tmp/cam-config.log`. It now derives from one fixed, reused *parent*
// directory with the pid nested into the filename, and is capped to a byte
// ceiling by the generated shell itself (the log is written by tmux
// `pipe-pane` inside a bash string, so the cap has to be a shell
// construction -- these tests run the ACTUAL generated snippets under real
// bash, never a simulated string check).
//
// The `buildConfigLogCapCommand` describe block below also covers the
// US-R1-004 site-4 follow-up: a post-hoc-trim shell construction
// (`cat >> LOG; tail -c N LOG > LOG.tmp && mv ...`) only rotates once the
// `cat` sees EOF, which for a live `tmux pipe-pane` only happens when the
// pipe itself closes (viewer pane exit) -- so for the whole session, the
// only period the file is actually being fed, the log grew unbounded. A
// test that spawns the command and only inspects the file AFTER the
// subprocess exits (as every test above already did, pre-US-R1-004) cannot
// observe that gap at all: the file looks correctly capped by the time you
// look, even from a construction that was unbounded the entire time it was
// live. The `keeps the log bounded WHILE still being written` test below
// samples the on-disk size WHILE the bash subprocess is still receiving
// input (mid-stream, well before `stdin.end()`), which is the only way to
// actually falsify the "bounded during the live session" property.
//
// Every scratch path lives under the repo-local scratch root
// (`createTestTmpdir`), never the real `/tmp` or `$TMPDIR`: `TMPDIR` is
// overridden for every spawned bash subprocess below so the snippets'
// `${TMPDIR:-/tmp}` resolution stays inside the scratch tree.

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createTestTmpdir } from './helpers/test-tmpdir';
import { waitForCondition } from './helpers/wait-for-condition';

import {
	buildConfigLogCapCommand,
	buildConfigLogCleanupCommand,
	buildConfigLogPathAssignment,
} from '../src/commands/setup.ts';

describe('buildConfigLogPathAssignment', () => {
	it('derives the log from a fixed parent, never the old shared /tmp/cam-config.log path', () => {
		const snippet = buildConfigLogPathAssignment();
		expect(snippet).toContain('cam-cli-config-log');
		expect(snippet).toContain('$$.log');
		expect(snippet).not.toContain('/tmp/cam-config.log');
	});

	it('two distinct pids produce two distinct paths under the same fixed parent (real bash, two subprocesses)', () => {
		const scratch = createTestTmpdir('cam-config-log-pid-');
		const script = `${buildConfigLogPathAssignment()}\necho "$$"\necho "$CAM_CONFIG_LOG"`;
		const env = { ...process.env, TMPDIR: scratch };

		const r1 = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
		const r2 = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
		expect(r1.status).toBe(0);
		expect(r2.status).toBe(0);

		const [pid1, path1] = r1.stdout.trim().split('\n');
		const [pid2, path2] = r2.stdout.trim().split('\n');
		expect(pid1).toBeTruthy();
		expect(pid2).toBeTruthy();
		expect(pid1).not.toBe(pid2);
		expect(path1).not.toBe(path2);

		// Same fixed parent directory for both.
		const parent1 = path1?.slice(0, path1.lastIndexOf('/'));
		const parent2 = path2?.slice(0, path2.lastIndexOf('/'));
		expect(parent1).toBe(parent2);
		expect(parent1).toContain('cam-cli-config-log');

		// Pid is the filename segment under that fixed parent, never a new
		// top-level unique entry.
		expect(path1).toBe(`${parent1}/${pid1}.log`);
		expect(path2).toBe(`${parent2}/${pid2}.log`);

		// The fixed parent must resolve inside the scratch root, not the real
		// /tmp -- proves TMPDIR was actually honored by the snippet.
		expect(parent1?.startsWith(scratch)).toBe(true);
	});

	it('pre-creates the log file itself, before any writer ever runs (CAM-510 v/V viewer-pane-dies-immediately regression)', () => {
		// The `v|V` viewer pane runs `tmux pipe-pane -o '<cap>'; tail -f
		// $CAM_CONFIG_LOG` -- `tail -f` exits immediately if the file does not
		// exist yet. `buildConfigLogCapCommand`'s writer only creates the file
		// lazily (its first `cat chunk >> LOG`), so this snippet is the only
		// thing standing between `tail -f` and that race. Assert the file
		// exists (empty, zero-byte) the instant this snippet returns, with NO
		// cap/writer command run at all -- proving the pre-creation lives here
		// rather than depending on writer timing.
		const scratch = createTestTmpdir('cam-config-log-precreate-');
		const script = `${buildConfigLogPathAssignment()}\necho "$CAM_CONFIG_LOG"`;
		const env = { ...process.env, TMPDIR: scratch };

		const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
		expect(result.status).toBe(0);
		const logPath = result.stdout.trim();
		expect(logPath).toBeTruthy();
		expect(existsSync(logPath)).toBe(true);
		expect(statSync(logPath).size).toBe(0);
	});
});

describe('buildConfigLogCapCommand', () => {
	it('never grows the resulting file past the byte ceiling, fed real input larger than the ceiling under real bash', () => {
		const scratch = createTestTmpdir('cam-config-log-cap-');
		const logPath = join(scratch, 'config.log');
		const ceiling = 1000;
		const command = buildConfigLogCapCommand(logPath, ceiling);

		// 5x the ceiling, well beyond what the cap should ever let survive.
		const input = 'x'.repeat(ceiling * 5);
		const r = spawnSync('bash', ['-c', command], { encoding: 'utf8', input });
		expect(r.status).toBe(0);

		expect(existsSync(logPath)).toBe(true);
		const size = statSync(logPath).size;
		expect(size).toBeLessThanOrEqual(ceiling);
		expect(size).toBeGreaterThan(0);

		// tail -c keeps the trailing bytes, not an arbitrary prefix/truncation.
		const content = readFileSync(logPath, 'utf8');
		expect(content).toBe('x'.repeat(size));

		// No leftover .tmp rotation artifact after the mv.
		expect(existsSync(`${logPath}.tmp`)).toBe(false);
	});

	it('leaves a small input (under the ceiling) untouched', () => {
		const scratch = createTestTmpdir('cam-config-log-cap-small-');
		const logPath = join(scratch, 'config.log');
		const ceiling = 1000;
		const command = buildConfigLogCapCommand(logPath, ceiling);

		const input = 'hello world\n';
		const r = spawnSync('bash', ['-c', command], { encoding: 'utf8', input });
		expect(r.status).toBe(0);

		expect(readFileSync(logPath, 'utf8')).toBe(input);
	});

	it('uses a tail -c based shell construction, not TypeScript-side truncation', () => {
		expect(buildConfigLogCapCommand('/some/path')).toMatch(/tail -c/);
	});

	it('runs correctly under a real POSIX-strict sh (dash if available), never leaking bash-only ((..)) arithmetic syntax or a stray ceiling-named file into cwd (US-R2-001)', () => {
		// tmux runs a `pipe-pane -o '<shell-command>'` argument via
		// `/bin/sh -c '...'` (tmux(1)), and on every Linux binary this project
		// ships (README: gateship-linux-x64/arm64) `/bin/sh` is dash. A prior
		// version of this command used the bash-only `(( $(wc -c < LOG) > N ))`
		// arithmetic-command rotate guard, which dash does not recognize and
		// mis-parses as nested subshells: the ceiling check silently never
		// fires (log grows unbounded) AND the mis-parse evaluates the numeric
		// ceiling literal as a command, spraying a stray file named after it
		// into the writer's cwd -- the user's repository, dirtying the tree the
		// plan-preflight clean-tree guard (ADR-0014) checks. Reproduced by hand
		// against the pre-fix snippet under real /bin/dash before writing this
		// test: `dash: N: <ceiling>: not found`, log left at the full unbounded
		// input size, and a stray file literally named `<ceiling>` in cwd.
		const scratch = createTestTmpdir('cam-config-log-posix-');
		const logPath = join(scratch, 'config.log');
		const ceiling = 500;
		const command = buildConfigLogCapCommand(logPath, ceiling);

		// Structural guard 1: `((` is the bash arithmetic-command marker and
		// must never appear in a snippet tmux may hand to a non-bash /bin/sh.
		expect(command).not.toContain('((');

		// Structural guard 2: this snippet's returned text is embedded verbatim
		// inside the OUTER menu script's own double-quoted `"tmux pipe-pane ...
		// -o '...'"` argument to `split-window` (buildSetupMenuScript) -- a
		// literal `"` or `'` anywhere here closes that outer quoting early and
		// corrupts the generated script (the pre-existing zero-quote convention
		// this snippet family already relied on, see the CAM-510
		// site-4-followup patterns.md bullet). A naive POSIX `test "$(wc -c <
		// LOG)" -gt N` fix (quoted) would reintroduce exactly this breakage;
		// the actual fix stays quote-free.
		expect(command).not.toContain('"');
		expect(command).not.toContain("'");

		const shell = existsSync('/bin/dash') ? '/bin/dash' : '/bin/sh';
		const input = 'x'.repeat(ceiling * 6);
		const r = spawnSync(shell, ['-c', command], { encoding: 'utf8', input, cwd: scratch });
		expect(r.status).toBe(0);

		expect(existsSync(logPath)).toBe(true);
		expect(statSync(logPath).size).toBeLessThanOrEqual(ceiling);

		// The dash mis-parse repro creates a stray file literally named after
		// the numeric ceiling ('500') in the writer's cwd; the POSIX-safe form
		// must never do this.
		expect(existsSync(join(scratch, String(ceiling)))).toBe(false);
	});

	it('keeps the log bounded WHILE still being written, not just after the writer exits (US-R1-004)', async () => {
		const scratch = createTestTmpdir('cam-config-log-live-');
		const logPath = join(scratch, 'config.log');
		const ceiling = 2000;
		const command = buildConfigLogCapCommand(logPath, ceiling);

		const proc = spawn('bash', ['-c', command], { stdio: ['pipe', 'ignore', 'ignore'] });

		// Feed well beyond the ceiling in small writes, sampling the on-disk
		// size BETWEEN writes -- i.e. while the bash subprocess (and its
		// internal dd/cat rotate loop) is still alive and receiving data. A
		// post-hoc-trim construction only rotates once this feed stops, so it
		// would let the observed size climb toward the full unbounded total
		// (40 * 500 = 20000 bytes, 10x the ceiling) during this loop.
		const writeChunk = 'x'.repeat(500);
		let sawNonEmptyMidStream = false;
		let maxObservedSize = 0;
		for (let i = 0; i < 40; i++) {
			proc.stdin?.write(writeChunk);
			// Fixed pacing delay is intentional: metronomic write/observe cadence
			// to catch mid-stream growth, not a poll-for-condition wait (CAM-510).
			await new Promise((resolve) => setTimeout(resolve, 15)); // CAM-510
			if (existsSync(logPath)) {
				const size = statSync(logPath).size;
				maxObservedSize = Math.max(maxObservedSize, size);
				if (size > 0) sawNonEmptyMidStream = true;
			}
		}
		proc.stdin?.end();
		await waitForCondition(() => proc.exitCode !== null, { timeoutMs: 5000 });

		expect(sawNonEmptyMidStream).toBe(true);
		// Generous slack above the ceiling for the dd chunk size (4096) used
		// between rotate checks, plus one write's worth -- but it must never
		// approach the full unbounded total that a post-hoc-trim construction
		// would have let through during this same live window.
		expect(maxObservedSize).toBeLessThan(ceiling + 4096 + 500);
	});
});

describe('buildConfigLogCleanupCommand', () => {
	it('removes the log file on menu exit, with no residue', () => {
		const scratch = createTestTmpdir('cam-config-log-cleanup-');
		const logPath = join(scratch, 'config.log');
		writeFileSync(logPath, 'some debug output\n', 'utf8');
		expect(existsSync(logPath)).toBe(true);

		const script = `CAM_CONFIG_LOG="${logPath}"; CAM_CONFIG_PANE=""; ${buildConfigLogCleanupCommand()}`;
		const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
		expect(r.status).toBe(0);

		expect(existsSync(logPath)).toBe(false);
	});

	it('is idempotent when the log file never existed (viewer was never opened)', () => {
		const scratch = createTestTmpdir('cam-config-log-cleanup-noop-');
		const logPath = join(scratch, 'never-created.log');
		expect(existsSync(logPath)).toBe(false);

		const script = `CAM_CONFIG_LOG="${logPath}"; CAM_CONFIG_PANE=""; ${buildConfigLogCleanupCommand()}`;
		const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
		expect(r.status).toBe(0);
		expect(existsSync(logPath)).toBe(false);
	});

	it('does not wait when no writer ever held the .lock sibling (fast path is unaffected by the drain wait)', () => {
		const scratch = createTestTmpdir('cam-config-log-cleanup-fast-');
		const logPath = join(scratch, 'config.log');
		writeFileSync(logPath, 'stale leftover from a previous run\n', 'utf8');
		expect(existsSync(`${logPath}.lock`)).toBe(false);

		const script = `CAM_CONFIG_LOG="${logPath}"; CAM_CONFIG_PANE=""; ${buildConfigLogCleanupCommand()}`;
		const startedAt = Date.now();
		const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
		const elapsedMs = Date.now() - startedAt;

		expect(r.status).toBe(0);
		expect(existsSync(logPath)).toBe(false);
		// No lock ever existed, so the drain-wait loop's condition must be
		// false on its very first check -- proves this doesn't regress into
		// always paying the poll cost, even in the (still common) case of a
		// stale file with no live writer.
		expect(elapsedMs).toBeLessThan(500);
	});
});

describe('config-pane debug log: EXIT-trap teardown vs writer rotate race (US-R1-005)', () => {
	// AC8-shaped regression coverage for the race described in this story:
	// `buildConfigLogCleanupCommand` used to fire `tmux pipe-pane` (closing
	// the pipe) immediately followed by `rm -f` on the very next line, while
	// the piped writer process (a separate process, not a child of the
	// cleanup script) could still be mid-flight finishing its current
	// `cat`/rotate cycle in the background. If that writer's pending `mv`
	// landed after the `rm`, the log file was recreated after cleanup and
	// survived the menu exit. `buildConfigLogCapCommand` and
	// `buildConfigLogCleanupCommand` were previously only ever tested in
	// isolation (the two describe blocks above), never composed, so neither
	// gate could observe this. These tests compose both halves.

	it('cleanup genuinely waits for an in-flight writer to release its .lock before removing the log, so a pending rotate cannot recreate it after cleanup runs', async () => {
		const scratch = createTestTmpdir('cam-config-log-drain-');
		const logPath = join(scratch, 'config.log');
		const lockPath = `${logPath}.lock`;

		// Simulate a writer that is still mid-flight: it already appended
		// content and holds its lock -- buildConfigLogCapCommand's own
		// contract is that the lock exists for the writer's entire
		// lifetime, removed only as its very last action once its loop
		// breaks on EOF.
		writeFileSync(logPath, 'partial output from an in-flight writer\n', 'utf8');
		writeFileSync(lockPath, '', 'utf8');

		const script = `CAM_CONFIG_LOG="${logPath}"; CAM_CONFIG_PANE=""; ${buildConfigLogCleanupCommand()}`;
		const cleanup = spawn('bash', ['-c', script], { stdio: ['ignore', 'ignore', 'ignore'] });

		// While the lock is still held, cleanup must NOT have finished (and
		// must NOT have removed the log yet) -- proves it is genuinely
		// waiting, not racing past the still-live writer.
		await new Promise((resolve) => setTimeout(resolve, 150)); // CAM-510
		expect(cleanup.exitCode).toBeNull();
		expect(existsSync(logPath)).toBe(true);

		// Now simulate the writer finishing: one more append (the pending
		// rotate landing) followed by releasing the lock as its final
		// action -- the exact ordering the fix relies on the trap to wait
		// out instead of racing.
		writeFileSync(logPath, 'partial output from an in-flight writer\nfinal chunk after EOF\n', 'utf8');
		rmSync(lockPath, { force: true });

		await waitForCondition(() => cleanup.exitCode !== null, { timeoutMs: 5000 });
		expect(cleanup.exitCode).toBe(0);
		expect(existsSync(logPath)).toBe(false);
		expect(existsSync(lockPath)).toBe(false);
	});

	it('composes the real writer and real cleanup commands end-to-end: closing the pipe and firing cleanup concurrently, without waiting, still leaves no residue', async () => {
		const scratch = createTestTmpdir('cam-config-log-compose-');
		const logPath = join(scratch, 'config.log');
		const ceiling = 500;
		const capCommand = buildConfigLogCapCommand(logPath, ceiling);
		const cleanupCommand = buildConfigLogCleanupCommand();

		const writer = spawn('bash', ['-c', capCommand], { stdio: ['pipe', 'ignore', 'ignore'] });

		// Feed well past the ceiling so a rotate is pending right as we tear
		// down, then close the writer's stdin -- this is the same EOF signal
		// tmux's own `pipe-pane` toggle-off delivers in production.
		for (let i = 0; i < 10; i++) {
			writer.stdin?.write('x'.repeat(200));
		}
		writer.stdin?.end();

		// Fire cleanup CONCURRENTLY, without waiting for the writer to
		// notice EOF and finish its own rotate/cleanup first -- exactly the
		// racy ordering this story exists to close.
		const script = `CAM_CONFIG_LOG="${logPath}"; CAM_CONFIG_PANE=""; ${cleanupCommand}`;
		const cleanup = spawn('bash', ['-c', script], { stdio: ['ignore', 'ignore', 'ignore'] });

		await waitForCondition(() => writer.exitCode !== null && cleanup.exitCode !== null, {
			timeoutMs: 5000,
		});

		expect(existsSync(logPath)).toBe(false);
		expect(existsSync(`${logPath}.chunk`)).toBe(false);
		expect(existsSync(`${logPath}.lock`)).toBe(false);
		expect(existsSync(`${logPath}.tmp`)).toBe(false);
	});
});
