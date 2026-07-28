// test/fixtures/init-home-redirect-probe.ts
//
// Child-process probe for test/init.test.ts (US-R2-001, CAM-458).
//
// Runs as a genuinely separate `bun` process, spawned with `HOME` set in the
// spawn-time env (see scripts/cam/patterns.md: Bun's `node:os` `homedir()`
// resolves once at process-init and does NOT react to `process.env.HOME`
// mutated mid-process — the ONLY way to redirect it is to set `HOME` before
// the Bun binary itself starts). Because this process's `HOME` is a freshly
// created empty temp dir, `~/.config/cam` is guaranteed absent before
// `runInit()` runs, on every machine (dev box or CI runner) — no dependency
// on what the *real* dev machine's `~/.config/cam` happens to contain.
//
// Prints `{"before": string[] | null, "after": string[] | null}` as one line
// of JSON to stdout; the parent test asserts `before === null && after ===
// null`, i.e. `runInit()` created nothing under the (isolated) config dir.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { runInit, type SpawnFn } from '../../src/commands/init.ts';

// Same deterministic stub as test/init.test.ts (CAM-205 spawn seam): fakes
// "claude not found on PATH" and a skipped vendored smoke so this probe never
// touches a real subprocess or depends on the runner's installed toolchain.
const stubSpawnFn: SpawnFn = (cmd, args) => {
	if (cmd === '/bin/sh' && args[0] === '-c' && args[1] === 'command -v claude') {
		return { status: 1, stdout: '', stderr: '' };
	}
	if (cmd === 'claude' && args[0] === '--version') {
		return { status: 0, stdout: 'Claude Code 2.5.0 (Sonnet 4.6)\n', stderr: '' };
	}
	if (cmd === 'bun') {
		return { status: 2, stdout: '[smoke] skipping — stubbed in probe\n', stderr: '' };
	}
	return { status: 1, stdout: '', stderr: `unexpected stub spawn: ${cmd} ${args.join(' ')}` };
};

/** Sorted directory listing, or `null` when the directory doesn't exist. */
function snapshotDir(dir: string): string[] | null {
	if (!existsSync(dir)) return null;
	return [...readdirSync(dir)].sort();
}

async function main(): Promise<void> {
	const configDir = join(homedir(), '.config', 'cam');
	const before = snapshotDir(configDir);

	// Run twice; exit codes are not the oracle here (PATH-coupling concern,
	// see test/init.test.ts header) — only config-dir contents are.
	await runInit({ spawnFn: stubSpawnFn });
	await runInit({ spawnFn: stubSpawnFn });

	const after = snapshotDir(configDir);
	process.stdout.write(`${JSON.stringify({ before, after })}\n`);
}

await main();
