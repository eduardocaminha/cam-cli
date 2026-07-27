// test/supervisor/sidecar-loop-spawn.test.ts
//
// US-003 (CAM-433), audit F-02: real-I/O proof that the PRODUCTION loop
// SpawnFn adapter preserves a subprocess's stderr and non-zero exit code.
//
// INVARIANCE PIN: `bun run typecheck` owns the additive compile-surface proof
// across loop.ts, review.ts, plan-runner.ts, and sidecar.ts. This behavioral
// test intentionally owns the separate runtime stderr proof.

import { expect, test } from 'bun:test';

import { makeProductionLoopSpawnFn } from '../../src/commands/sidecar.ts';

test('production loop spawn factory decodes real stderr on a non-zero subprocess exit', () => {
	const knownStderr = 'cam-433-real-stderr';
	const spawn = makeProductionLoopSpawnFn(process.cwd());
	const result = spawn(process.execPath, [
		'-e',
		`process.stderr.write(${JSON.stringify(knownStderr)}); process.exit(23);`,
	]);

	expect(result.exitCode).toBe(23);
	expect(result.stderr).toBe(knownStderr);
});
