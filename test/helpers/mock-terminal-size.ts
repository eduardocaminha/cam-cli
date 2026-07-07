// test/helpers/mock-terminal-size.ts
//
// Root-cause fix for CAM-201 Ink render flakiness under heavy concurrent
// `bun test` load: `ink-testing-library`'s fake `Stdout` defines a `columns`
// getter (100) but no `rows` getter (see
// node_modules/ink-testing-library/build/index.js), so `stdout.rows` is
// always `undefined`. Ink's `getWindowSize` (node_modules/ink/build/utils.js)
// treats `columns && rows` as the "trust stdout" gate; since `rows` is
// falsy, EVERY ink-testing-library render falls through to the
// `terminal-size` package, which shells out to `tput` synchronously
// (`Bun.spawnSync`-equivalent via node:child_process's `execFileSync`).
//
// Under a lightly loaded machine that synchronous spawn is fast and
// invisible. Under the CPU contention of a full `bun test` run (hundreds of
// files, many of them spawning their own subprocesses), that same spawn can
// take anywhere from a few milliseconds to multiple seconds, which is the
// actual source of the "how many macrotask ticks does this need" variance
// this file's callers used to paper over with a bun-version-probe skip
// (CAM-186) or a fixed tick count. Stubbing `terminal-size` to return a
// fixed size removes the synchronous spawn entirely, making every ink
// render in these tests settle in a single real macrotask tick regardless
// of host load or bun version.
import { mock } from 'bun:test';

let installed = false;

/**
 * Replace the `terminal-size` module with a synchronous, allocation-free
 * stub. Idempotent (safe to call from multiple test files); `bun:test`
 * module mocks are process-global, so this only needs to run once.
 */
export function installTerminalSizeMock(): void {
	if (installed) return;
	installed = true;
	mock.module('terminal-size', () => ({
		default: () => ({ columns: 80, rows: 24 }),
	}));
}
