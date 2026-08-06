// test/fixtures/reap-preload-fixture.ts
//
// Child-process fixture for test/helpers/test-tmpdir.test.ts's run-wide
// reaper test (US-R1-002, CAM-508). Deliberately named without `.test.` so
// the repo-wide `bun test` sweep never collects it on its own; the parent
// test spawns it via an EXPLICIT path argument (`bun test <this file>`),
// which Bun runs regardless of filename convention (confirmed empirically,
// bun 1.3.13). That spawn is the real `bun test` runner -- not `bun -e` --
// so it proves the `bunfig.toml` `[test].preload` + `afterAll` teardown
// (test/helpers/reap-preload.ts) actually reaps a directory created via
// `createTestTmpdir` during a genuine test run, closing the gap this story
// fixes (the exit-time `process.on('exit', ...)` hook in
// test/helpers/test-tmpdir.ts never fires under `bun test`).

import { test } from 'bun:test';
import { createTestTmpdir } from '../helpers/test-tmpdir';

test('creates a scratch dir and reports its path for the parent process', () => {
	const dir = createTestTmpdir('cam-reap-fixture-');
	console.log(`CAM_REAP_FIXTURE_DIR:${dir}`);
});
