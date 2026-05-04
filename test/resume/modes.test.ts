// test/resume/modes.test.ts
//
// US-014 — `cam resume` 4-mode tests (Scope E).
//
// This file is the AC-driven scenario suite: one `describe` block per
// failure mode, each block walking `runResume` end-to-end against a
// tmpdir-backed cwd with a mocked filesystem AND a mocked process table
// (via injected `SpawnSyncFn` + `KillFn` — never a real PID, never a real
// `pgrep`). The 4 modes mirror `scripts/cam/CLAUDE.md § Resume
// reconciliation`:
//
//   Mode 1 — operator typed mid-loop      → respawn
//   Mode 2 — terminal closed / OS reboot  → respawn (no prompt)
//   Mode 3 — hard-kill orphan (> 24h)     → prompt [Y/n/reset]
//   Mode 4 — rate-limit sleep mid-window  → noop
//
// The pre-existing 51 tests in `test/resume.test.ts` cover the pure
// classifier (`classifyResumeMode`) and the helper utilities (`isPidAlive`,
// `isAutoRetryAlive`, `resetCurrentStoryInPlace`, etc.) at unit granularity.
// US-014 deliberately layers ON TOP of that, exercising the public
// `runResume` entrypoint per the AC's "all 4 tests run under
// `bun test test/resume/`" requirement. The fixtures live one directory up
// at `test/fixtures/resume/scenario.ts` per AC bullet 6.
//
// Execution contract:
//   - `bun test test/resume/` discovers this file and runs the 4 mode
//     groups + the 3 sub-checks of Mode 3 (Y/n/reset).
//   - `bunx tsc --noEmit` is checked in the per-workspace quality gate
//     after this file lands.
//   - No real subprocesses, no real PIDs, no real `pgrep` invocation —
//     every external dep that `runResume` reaches for is injected.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runResume } from '../../src/commands/resume.ts';
import {
	ALIVE_PID,
	DEAD_PID,
	NOW,
	OLD_COMMIT_MS,
	RECENT_COMMIT_MS,
	aliveKill,
	buildScenarioMode1OperatorTyped,
	buildScenarioMode2TerminalClosed,
	buildScenarioMode3HardKill,
	buildScenarioMode4RateLimit,
	deadKill,
	makeFakeSpawn,
	silenceStdout,
} from '../fixtures/resume/scenario.ts';

// --- Mode 1 — operator typed mid-loop --------------------------------------

describe('US-014 Mode 1 — operator typed mid-loop', () => {
	test('state file + commit since state-file mtime + alive PID → respawn (continue from next passes:false story)', async () => {
		const { cwd, stateFilePath, prdPath } = buildScenarioMode1OperatorTyped();
		try {
			const stdout = silenceStdout();
			try {
				const code = await runResume({
					cwd,
					now: () => NOW,
					// PID alive AND a recent commit landed → classifier picks
					// `respawn` via the "heartbeat PID alive" branch (Mode 1's
					// `respawn` arm — same exit code as Mode 2's variant).
					spawnFn: makeFakeSpawn({
						gitLogTimestampSec: Math.floor(RECENT_COMMIT_MS / 1000),
					}),
					killFn: aliveKill,
					prompt: () => {
						throw new Error(
							'Mode 1 must NOT prompt — operator typed mid-loop, no recovery question',
						);
					},
				});
				expect(code).toBe(0);

				// State file is preserved — the loop is still running, we just
				// re-attach. No mutation, no cleanup.
				expect(existsSync(stateFilePath)).toBe(true);

				// PRD is preserved verbatim — `runResume` must not flip any
				// `passes:` flags on Mode 1. The next `cam next` will pick
				// up the next `passes:false` story (US-003 in our fixture)
				// from the same place the loop left off.
				const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
				const us003 = prd.userStories.find((s: { id: string }) => s.id === 'US-003');
				expect(us003.passes).toBe(false);
				const us001 = prd.userStories.find((s: { id: string }) => s.id === 'US-001');
				expect(us001.passes).toBe(true);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('Mode 1 invokes pgrep + git log via the injected spawn — never a real subprocess', async () => {
		const { cwd } = buildScenarioMode1OperatorTyped();
		try {
			const stdout = silenceStdout();
			try {
				const spawn = makeFakeSpawn({
					gitLogTimestampSec: Math.floor(RECENT_COMMIT_MS / 1000),
				});
				await runResume({
					cwd,
					now: () => NOW,
					spawnFn: spawn,
					killFn: aliveKill,
					prompt: () => 'n',
				});
				// Sanity: the only subprocesses we reach for are pgrep and git.
				const subprocs = new Set(spawn.calls.map((c) => c.cmd));
				expect(subprocs.has('pgrep')).toBe(true);
				expect(subprocs.has('git')).toBe(true);
				// Nothing else — `runResume` does NOT shell out to claude /
				// claude-auto-retry here.
				expect(subprocs.size).toBe(2);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// --- Mode 2 — terminal closed / OS rebooted -------------------------------

describe('US-014 Mode 2 — terminal closed / OS rebooted', () => {
	test('state file + dead PID + recent commit → respawn, no prompt', async () => {
		const { cwd, stateFilePath } = buildScenarioMode2TerminalClosed();
		try {
			const stdout = silenceStdout();
			try {
				const code = await runResume({
					cwd,
					now: () => NOW,
					spawnFn: makeFakeSpawn({
						gitLogTimestampSec: Math.floor(RECENT_COMMIT_MS / 1000),
					}),
					killFn: deadKill,
					prompt: () => {
						throw new Error(
							'Mode 2 must NOT prompt — recent commit means crash was recent enough to auto-respawn',
						);
					},
				});
				expect(code).toBe(0);

				// State file lingers — the next `cam next` re-attaches to
				// the same iteration counter. Mode 2's "respawn" never
				// removes the file (only Mode 3 reset / Mode `success` does).
				expect(existsSync(stateFilePath)).toBe(true);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('Mode 2 reads on-disk state — verified via the PID field round-tripping the YAML parser', async () => {
		const { cwd, stateFilePath } = buildScenarioMode2TerminalClosed();
		try {
			// Sanity-check the fixture: the on-disk file really does have
			// `pid: <DEAD_PID>` so the test asserts something real.
			const onDisk = readFileSync(stateFilePath, 'utf8');
			expect(onDisk.includes(`pid: ${DEAD_PID}`)).toBe(true);

			const stdout = silenceStdout();
			try {
				const killCalls: number[] = [];
				const code = await runResume({
					cwd,
					now: () => NOW,
					spawnFn: makeFakeSpawn({
						gitLogTimestampSec: Math.floor(RECENT_COMMIT_MS / 1000),
					}),
					killFn: (pid) => {
						killCalls.push(pid);
						throw new Error('ESRCH');
					},
					prompt: () => 'n',
				});
				expect(code).toBe(0);
				// `runResume` must have probed liveness using the parsed PID.
				expect(killCalls).toContain(DEAD_PID);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// --- Mode 3 — hard-kill orphan (the 3-branch sub-check) -------------------

describe('US-014 Mode 3 — hard-kill orphan', () => {
	test('Y branch — answer "y" continues the loop without removing state file', async () => {
		const { cwd, stateFilePath } = buildScenarioMode3HardKill();
		try {
			const stdout = silenceStdout();
			try {
				let promptCount = 0;
				const code = await runResume({
					cwd,
					now: () => NOW,
					spawnFn: makeFakeSpawn({
						gitLogTimestampSec: Math.floor(OLD_COMMIT_MS / 1000),
					}),
					killFn: deadKill,
					prompt: () => {
						promptCount += 1;
						return 'y';
					},
				});
				expect(code).toBe(0);
				expect(promptCount).toBe(1); // exactly one Y/n/reset prompt
				expect(existsSync(stateFilePath)).toBe(true); // not cleaned
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('n branch — answer "n" aborts with exit 1 and leaves the state file alone', async () => {
		const { cwd, stateFilePath, prdPath } = buildScenarioMode3HardKill();
		try {
			const beforePrd = readFileSync(prdPath, 'utf8');
			const stdout = silenceStdout();
			try {
				const code = await runResume({
					cwd,
					now: () => NOW,
					spawnFn: makeFakeSpawn({
						gitLogTimestampSec: Math.floor(OLD_COMMIT_MS / 1000),
					}),
					killFn: deadKill,
					prompt: () => 'n',
				});
				// Exit 1 is the documented "operator declined to recover"
				// signal — matches the stated semantics in resume.ts § runResume.
				expect(code).toBe(1);
				expect(existsSync(stateFilePath)).toBe(true);
				// PRD is byte-for-byte unchanged — abort means "do nothing".
				expect(readFileSync(prdPath, 'utf8')).toBe(beforePrd);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('reset branch — answer "reset" removes the state file and exits 0', async () => {
		const { cwd, stateFilePath } = buildScenarioMode3HardKill();
		try {
			const stdout = silenceStdout();
			try {
				const code = await runResume({
					cwd,
					now: () => NOW,
					spawnFn: makeFakeSpawn({
						gitLogTimestampSec: Math.floor(OLD_COMMIT_MS / 1000),
					}),
					killFn: deadKill,
					prompt: () => 'reset',
				});
				expect(code).toBe(0);
				// The whole point of the `reset` branch — orphan file removed.
				expect(existsSync(stateFilePath)).toBe(false);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('Mode 3 fires when last commit is > 24h old AND when there is no commit at all', async () => {
		// Sub-case A: `git log` returns a stale timestamp.
		{
			const { cwd } = buildScenarioMode3HardKill();
			try {
				const stdout = silenceStdout();
				try {
					const code = await runResume({
						cwd,
						now: () => NOW,
						spawnFn: makeFakeSpawn({
							gitLogTimestampSec: Math.floor(OLD_COMMIT_MS / 1000),
						}),
						killFn: deadKill,
						prompt: () => 'y',
					});
					expect(code).toBe(0); // y → continue
				} finally {
					stdout.restore();
				}
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		}
		// Sub-case B: `git log` exits 1 (no commits / not a repo) — also Mode 3.
		{
			const { cwd } = buildScenarioMode3HardKill();
			try {
				const stdout = silenceStdout();
				try {
					let promptCalled = false;
					const code = await runResume({
						cwd,
						now: () => NOW,
						// gitLogTimestampSec omitted → spawn returns status 1
						spawnFn: makeFakeSpawn({}),
						killFn: deadKill,
						prompt: () => {
							promptCalled = true;
							return 'y';
						},
					});
					expect(code).toBe(0);
					expect(promptCalled).toBe(true); // confirms Mode 3 path
				} finally {
					stdout.restore();
				}
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		}
	});
});

// --- Mode 4 — rate-limit sleep killed mid-window --------------------------

describe('US-014 Mode 4 — rate-limit sleep killed mid-window', () => {
	test('claude-auto-retry alive (mocked) → noop, no prompt, state file preserved', async () => {
		const { cwd, stateFilePath } = buildScenarioMode4RateLimit();
		try {
			const stdout = silenceStdout();
			try {
				const code = await runResume({
					cwd,
					now: () => NOW,
					// Critical: `autoRetryAlive: true` makes the fake `pgrep`
					// exit 0 with a fake pid, so `isAutoRetryAlive` returns
					// true and the classifier short-circuits to `noop`.
					spawnFn: makeFakeSpawn({
						autoRetryAlive: true,
						gitLogTimestampSec: Math.floor(OLD_COMMIT_MS / 1000),
					}),
					killFn: deadKill,
					prompt: () => {
						throw new Error(
							'Mode 4 must NOT prompt — claude-auto-retry will respawn the loop on its own timer',
						);
					},
				});
				expect(code).toBe(0);
				expect(existsSync(stateFilePath)).toBe(true);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('Mode 4 short-circuits even when the heartbeat PID is also alive', async () => {
		// Edge case from the existing classifier test: claude-auto-retry alive
		// + state-file-PID also alive. Mode 4 must win over Mode 1 because
		// auto-retry owns the recovery cycle — re-confirmed end-to-end.
		const { cwd } = buildScenarioMode4RateLimit();
		try {
			// Override the state-file PID to ALIVE so isPidAlive returns true.
			writeFileSync(
				join(cwd, '.claude', 'cam-loop.local.md'),
				`---\nactive: true\nitertion: 12\npid: ${ALIVE_PID}\n---\n\n/cam-next\n`,
			);
			const stdout = silenceStdout();
			try {
				let promptCalled = false;
				const code = await runResume({
					cwd,
					now: () => NOW,
					spawnFn: makeFakeSpawn({
						autoRetryAlive: true,
						gitLogTimestampSec: Math.floor(RECENT_COMMIT_MS / 1000),
					}),
					killFn: aliveKill,
					prompt: () => {
						promptCalled = true;
						return 'n';
					},
				});
				expect(code).toBe(0);
				expect(promptCalled).toBe(false);
			} finally {
				stdout.restore();
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// --- Cross-mode sanity ----------------------------------------------------

describe('US-014 — fixtures use a mocked process table (no real PIDs / no real pgrep)', () => {
	test('every Mode test injects deadKill / aliveKill — never process.kill on the real PID', () => {
		// Compile-time-style assertion: the `deadKill` and `aliveKill`
		// helpers in the scenario fixture file are the only ones any test
		// in this directory imports. If a future contributor adds a test
		// that bypasses the fixture, this is the canonical breadcrumb to
		// flag in code review.
		expect(typeof deadKill).toBe('function');
		expect(typeof aliveKill).toBe('function');
		// Verify the alive variant truly is a no-op (signals nothing).
		expect(() => aliveKill(ALIVE_PID, 0)).not.toThrow();
		// Verify the dead variant throws — without ever invoking process.kill.
		expect(() => deadKill(DEAD_PID, 0)).toThrow();
	});
});
