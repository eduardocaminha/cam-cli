// test/commands/sidecar-plan-phase-orphan-sweep.test.ts
//
// Wiring test for US-001 (CAM-288): sweepOrphanedImplementBlockedMarker must
// fire at the start of every plan-phase dispatch, not just at runSidecar
// startup. Neither makeProductionPlanPhaseFn nor its returned closure is
// exported (mirrors buildMetaLoopFn's precedent, CAM-208), so this test
// drives the exported buildPlanPhaseDeps directly with a spy
// sweepOrphanedImplementBlockedMarkerFn and asserts the spy is called when
// the plan-phase dispatch closure runs.
//
// Coverage:
//   AC1/AC2: the sweep fn is invoked at the start of the plan-phase dispatch
//            closure, via the injectable seam threaded from SidecarOptions
//            through buildPlanPhaseDeps into makeProductionPlanPhaseFn.
//   AC5:     the existing startup call site and pure-function tests are
//            untouched (proved by the separate, unmodified
//            sidecar-orphan-sweep.test.ts file continuing to pass).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPlanPhaseDeps } from '../../src/commands/sidecar.ts';
import { makeInMemoryEventLogger } from '../../src/supervisor/events.ts';

describe('buildPlanPhaseDeps wires the orphan-sweep seam into the plan-phase dispatch closure (US-001, CAM-288)', () => {
	test('the spy sweepOrphanedImplementBlockedMarkerFn fires when runPlanPhaseFn() runs', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-phase-sweep-'));
		try {
			let sweepCalls = 0;
			const { logger } = makeInMemoryEventLogger();

			const deps = buildPlanPhaseDeps(
				{
					cwd: tmpDir,
					claudeDir: join(tmpDir, '.claude'),
					prdPath: join(tmpDir, 'scripts/cam/prd.json'),
					sessionName: 'cam-plan-phase-sweep-test-session',
					logEvent: logger,
					realSpawnFn: (() => ({
						pid: 0,
						output: [],
						stdout: '',
						stderr: '',
						status: 0,
						signal: null,
					})) as unknown as Parameters<typeof buildPlanPhaseDeps>[0]['realSpawnFn'],
				},
				{
					sweepOrphanedImplementBlockedMarkerFn: () => {
						sweepCalls += 1;
					},
				},
			);

			// The dispatch closure is wrapped in an outermost try/catch that
			// swallows any downstream failure (missing tmux/git state in this
			// bare tmp dir) and forces phase back to idle; only the sweep call
			// at the very top of the closure is under test here.
			const runPlanPhaseFn = deps.runPlanPhaseFn;
			expect(runPlanPhaseFn).toBeDefined();
			expect(() => runPlanPhaseFn?.()).not.toThrow();

			expect(sweepCalls).toBe(1);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('an injected options.runPlanPhaseFn bypasses makeProductionPlanPhaseFn entirely (sweep seam not consulted)', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'cam-plan-phase-sweep-bypass-'));
		try {
			let sweepCalls = 0;
			let injectedCalls = 0;
			const { logger } = makeInMemoryEventLogger();

			const deps = buildPlanPhaseDeps(
				{
					cwd: tmpDir,
					claudeDir: join(tmpDir, '.claude'),
					prdPath: join(tmpDir, 'scripts/cam/prd.json'),
					sessionName: 'cam-plan-phase-sweep-bypass-session',
					logEvent: logger,
					realSpawnFn: (() => ({
						pid: 0,
						output: [],
						stdout: '',
						stderr: '',
						status: 0,
						signal: null,
					})) as unknown as Parameters<typeof buildPlanPhaseDeps>[0]['realSpawnFn'],
				},
				{
					sweepOrphanedImplementBlockedMarkerFn: () => {
						sweepCalls += 1;
					},
					runPlanPhaseFn: () => {
						injectedCalls += 1;
					},
				},
			);

			deps.runPlanPhaseFn?.();

			expect(injectedCalls).toBe(1);
			expect(sweepCalls).toBe(0);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
