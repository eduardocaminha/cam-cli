// test/integration/dashboard-pane-selfspawn.test.ts
//
// Integration test (REAL tmux): US-002 (CAM-482) drops the literal binary
// name from every self-respawn site and replaces it with an execPath-derived
// argv (buildSelfSpawnArgv / resolveSelfInvokeArgv, src/util/self-invoke.ts).
// In INTERPRETED mode that argv is a multi-element array: [runtime, script,
// ...subcommandArgs] (e.g. the dashboard pane's [bun, index.ts, 'dashboard',
// orchPaneId]).
//
// A unit fake that just records "the array had these elements" cannot catch
// whether tmux's OWN command-line handling actually preserves each element
// as a single execve argv word once it reaches a real pane, versus
// reassembling/re-splitting them (the exact class of bug the CAM-55 anchor
// documents: fakes return the output the code expects, only a real tmux
// round-trip proves the wire behavior). This test proves the multi-element
// runtime+script shape survives a REAL `tmux respawn-pane` unmangled: a path
// element containing an internal space arrives at the spawned process as ONE
// argv token, not split apart, and a trailing payload argument likewise
// survives intact.
//
// Isolation: runs on a private test socket (`-L cam-it-selfspawn`), never the
// real `cam` session socket. Skips cleanly when tmux is absent.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { buildSelfSpawnArgv } from '../../src/util/self-invoke.ts';
import { waitForCondition } from '../helpers/wait-for-condition.ts';
import { tmuxAvailable } from '../helpers/test-deps.ts';

// Per-process socket name: a fixed name is destroyed by any second process
// running this same file concurrently (its beforeEach/afterEach kill-server
// tears down the FIRST instance's server mid-test, killing the respawned
// pane child before it can write marker.json). Deriving the socket from
// process.pid makes kill-server unable to cross instances (CAM-482 US-R8-001).
const TEST_SOCK = `cam-it-selfspawn-${process.pid}`;
const SESSION = 'selfspawn';

function tmuxRaw(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync('tmux', ['-L', TEST_SOCK, ...args], { stdio: 'pipe' });
}

function paneIds(sessionName: string): string[] {
	return tmuxRaw(['list-panes', '-t', sessionName, '-F', '#{pane_id}'])
		.stdout.toString()
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

let workDir: string;

beforeEach(async () => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
	tmuxRaw(['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '10']);
	await waitForCondition(() => tmuxRaw(['has-session', '-t', SESSION]).status === 0);
	workDir = mkdtempSync(join(tmpdir(), 'cam-it-selfspawn-'));
});

afterEach(() => {
	if (!tmuxAvailable) return;
	tmuxRaw(['kill-server']);
	if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test.skipIf(!tmuxAvailable)(
	'a real tmux respawn-pane started from a runtime+script execPath-derived argv is NOT mangled: the space-bearing script path and a space-bearing trailing payload both arrive as single, intact argv tokens',
	async () => {
		// Script directory + filename deliberately contain a space, so a
		// respawn-pane that re-splits its trailing words on whitespace instead of
		// preserving each element as one argv token would corrupt the path and
		// the child would never run (marker file never appears) or the payload
		// argv would arrive fragmented.
		const scriptDir = join(workDir, 'cam script dir');
		mkdirSync(scriptDir, { recursive: true });
		const scriptPath = join(scriptDir, 'run me.ts');
		const markerPath = join(workDir, 'marker.json');

		writeFileSync(
			scriptPath,
			[
				"import { writeFileSync } from 'node:fs';",
				'const [marker, payload] = process.argv.slice(2);',
				'writeFileSync(marker, JSON.stringify({ argc: process.argv.length, payload }));',
			].join('\n'),
			'utf8',
		);

		// Mirrors the production interpreted-mode shape: [runtime, script,
		// ...subcommandArgs] built via buildSelfSpawnArgv (src/util/self-invoke.ts),
		// the exact helper the dashboard/sidecar/watcher self-respawn sites reuse
		// (US-002, CAM-482).
		const payload = 'hello world with spaces';
		const argv = buildSelfSpawnArgv(process.execPath, scriptPath, markerPath, payload);
		expect(argv.length).toBeGreaterThanOrEqual(4); // runtime + script + marker + payload

		const paneId = paneIds(SESSION)[0]!;
		const respawn = tmuxRaw(['respawn-pane', '-k', '-t', paneId, ...argv]);
		expect(respawn.status).toBe(0);

		await waitForCondition(() => existsSync(markerPath), { timeoutMs: 10000 });

		const written = JSON.parse(readFileSync(markerPath, 'utf8')) as { argc: number; payload: string };
		// process.argv = [bun, scriptPath, marker, payload] -> length 4. If tmux
		// had mangled/re-split the argv, either the script would never have run
		// (no marker) or this payload would not match verbatim.
		expect(written.argc).toBe(4);
		expect(written.payload).toBe(payload);
	},
	{ timeout: 15_000 },
);
