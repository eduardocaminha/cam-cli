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
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
});
