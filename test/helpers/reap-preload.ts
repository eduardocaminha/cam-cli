// test/helpers/reap-preload.ts
//
// Run-wide teardown for the test-scratch helper (US-R1-002, CAM-508). Loaded
// once, before any test file, via bunfig.toml's `[test].preload` (Bun's
// documented mechanism for global setup/teardown across a whole `bun test`
// invocation: https://bun.sh/docs/test/lifecycle, "Global Setup and
// Teardown" -- "define the hooks in a separate file" + "use --preload to
// run the setup script before any test files"). `afterAll` registered here,
// outside any `describe` block, is file-scoped to THIS file, and since this
// file is the very first thing `bun test` loads, its scope is effectively
// the entire run: it fires once, after every test file's own tests have
// finished, and reaps every directory `createTestTmpdir` created anywhere
// in the run (`test/helpers/test-tmpdir.ts`'s exit-time
// `process.on('exit', ...)` hook never fires under `bun test`, see that
// file's header comment).

import { afterAll } from 'bun:test';
import { reapOwnDirectories } from './test-tmpdir';

afterAll(() => {
	reapOwnDirectories();
});
