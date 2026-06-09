// test/next.test.ts
//
// Unit tests for `cam next` (US-007: Rewire to supervisor + retire stop-hook driver).
//
// What we cover per acceptance criteria:
//   1. Supervisor dispatch happy path: runNext calls runSupervisor() with the
//      right arguments (permissionMode, workerPaneId, prdPath, handoffPath, etc.).
//   2. State-file shape contract: the file written to .claude/cam-loop.local.md
//      has the fields parseStateFile expects (iteration, started_at, pid,
//      session_id, max_iterations, active) and no stop-hook re-inject body.
//   3. No stop-hook artifacts: settings.local.json hooks block is NOT written,
//      .claude/hooks/cam-loop-stop.sh is NOT created.
//   4. Missing worker pane: returns 1 and does not invoke supervisorFn.
//   5. State-file write failure: returns 1 and does not invoke supervisorFn.
//   6. Supervisor blocked: returns 1.
//   7. Supervisor max-iterations: returns 1.
//   8. Supervisor complete: returns 0.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	runNext,
	renderStateFile,
	writeStateFile,
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_COMPLETION_PROMISE,
	DEFAULT_TASK_PROMPT,
} from '../src/commands/next.ts';
import type { RunSupervisorOptions, SupervisorResult } from '../src/supervisor/loop.ts';
import yaml from 'js-yaml';

// --- Fake supervisor factory ------------------------------------------------

interface FakeSupervisorCall {
	opts: RunSupervisorOptions;
}

function makeFakeSupervisor(result: SupervisorResult): {
	supervisorFn: (opts: RunSupervisorOptions) => Promise<SupervisorResult>;
	calls: FakeSupervisorCall[];
} {
	const calls: FakeSupervisorCall[] = [];
	return {
		supervisorFn: async (opts: RunSupervisorOptions) => {
			calls.push({ opts });
			return result;
		},
		calls,
	};
}

// --- renderStateFile -------------------------------------------------------

describe('renderStateFile', () => {
	test('substitutes all YAML frontmatter fields', () => {
		const out = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			startedAt: '2026-06-08T12:00:00Z',
			sessionId: 'sess-abc',
			pid: 4242,
		});
		expect(out).toContain('max_iterations: 30');
		expect(out).toContain('completion_promise: "COMPLETE"');
		expect(out).toContain('started_at: "2026-06-08T12:00:00Z"');
		expect(out).toContain('session_id: sess-abc');
		expect(out).toContain('active: true');
		expect(out).toContain('iteration: 1');
		expect(out).toContain('pid: 4242');
	});

	test('body is empty — no stop-hook re-inject prompt', () => {
		const out = renderStateFile({
			maxIterations: 30,
			completionPromise: 'COMPLETE',
			startedAt: '2026-06-08T12:00:00Z',
			sessionId: '',
			pid: 1,
		});
		// Split at the closing YAML delimiter and verify body is blank/whitespace only.
		const parts = out.split(/^---$/m);
		// parts[0] = '---\n...', parts[1] = YAML body, parts[2] = content after second ---
		// The content after the closing --- should be empty (no /cam-next, no prompt text).
		const bodyAfterDelimiter = (parts[2] ?? '').trim();
		expect(bodyAfterDelimiter).toBe('');
	});

	test('emits null for empty completion-promise', () => {
		const out = renderStateFile({
			maxIterations: 0,
			completionPromise: '',
			startedAt: '2026-06-08T12:00:00Z',
			sessionId: '',
			pid: 1,
		});
		expect(out).toContain('completion_promise: null');
	});

	test('state file parses as valid YAML frontmatter with expected fields', () => {
		const out = renderStateFile({
			maxIterations: 50,
			completionPromise: 'COMPLETE',
			startedAt: '2026-06-08T12:00:00Z',
			sessionId: 'test-session',
			pid: 9999,
		});
		// Extract YAML section between the two --- delimiters.
		const lines = out.split('\n');
		let endIdx = -1;
		for (let i = 1; i < lines.length; i += 1) {
			if (lines[i]?.trim() === '---') { endIdx = i; break; }
		}
		expect(endIdx).toBeGreaterThan(0);
		const yamlSection = lines.slice(1, endIdx).join('\n');
		const parsed = yaml.load(yamlSection) as Record<string, unknown>;
		expect(parsed['active']).toBe(true);
		expect(parsed['iteration']).toBe(1);
		expect(parsed['max_iterations']).toBe(50);
		expect(parsed['session_id']).toBe('test-session');
		expect(typeof parsed['started_at']).toBe('string');
		expect(parsed['pid']).toBe(9999);
	});
});

// --- writeStateFile --------------------------------------------------------

describe('writeStateFile', () => {
	test('creates .claude/ when missing and writes the body', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-write-'));
		try {
			const written = writeStateFile(dir, 'hello\n');
			expect(written).toBe(join(dir, '.claude', 'cam-loop.local.md'));
			expect(existsSync(written)).toBe(true);
			expect(readFileSync(written, 'utf8')).toBe('hello\n');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('refuses to clobber an existing state file unless force=true', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-clobber-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			require('node:fs').writeFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'old\n');
			expect(() => writeStateFile(dir, 'new\n')).toThrow();
			writeStateFile(dir, 'newer\n', { force: true });
			expect(readFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'utf8')).toBe('newer\n');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// --- runNext integration ---------------------------------------------------

describe('runNext', () => {
	test('supervisor dispatch happy path: calls supervisorFn with correct args', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-dispatch-'));
		try {
			const { supervisorFn, calls } = makeFakeSupervisor({
				status: 'complete',
				iterations: 2,
				lastOutcome: null,
			});

			const code = await runNext({
				cwd: dir,
				permissionMode: 'bypassPermissions',
				writer: (_cwd2, _body) => '/fake/.claude/cam-loop.local.md',
				workerPaneReader: (_claudeDir) => '%5',
				supervisorFn,
				startedAt: '2026-06-08T12:00:00Z',
				sessionId: 'test-session',
				pid: 1234,
				prdPath: join(dir, 'scripts/cam/prd.json'),
				handoffPath: join(dir, 'scripts/cam/handoff.json'),
			});

			expect(code).toBe(0);
			expect(calls).toHaveLength(1);
			expect(calls[0]!.opts.workerPaneId).toBe('%5');
			expect(calls[0]!.opts.permissionMode).toBe('bypassPermissions');
			expect(calls[0]!.opts.prdPath).toBe(join(dir, 'scripts/cam/prd.json'));
			expect(calls[0]!.opts.handoffPath).toBe(join(dir, 'scripts/cam/handoff.json'));
			expect(calls[0]!.opts.maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
			expect(calls[0]!.opts.taskPrompt).toBe(DEFAULT_TASK_PROMPT);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('state-file shape contract: written fields match parseStateFile expectations', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-state-'));
		try {
			const { supervisorFn } = makeFakeSupervisor({
				status: 'complete',
				iterations: 1,
				lastOutcome: null,
			});

			await runNext({
				cwd: dir,
				permissionMode: 'bypassPermissions',
				workerPaneReader: (_claudeDir) => '%5',
				supervisorFn,
				startedAt: '2026-06-08T12:00:00Z',
				sessionId: 'shape-test',
				pid: 5678,
			});

			const statePath = join(dir, '.claude', 'cam-loop.local.md');
			expect(existsSync(statePath)).toBe(true);
			const body = readFileSync(statePath, 'utf8');

			// YAML frontmatter fields
			expect(body).toContain('active: true');
			expect(body).toContain('iteration: 1');
			expect(body).toContain('session_id: shape-test');
			expect(body).toContain('started_at: "2026-06-08T12:00:00Z"');
			expect(body).toContain('pid: 5678');
			expect(body).toContain(`max_iterations: ${DEFAULT_MAX_ITERATIONS}`);

			// No stop-hook re-inject body
			const lines = body.split('\n');
			let closingIdx = -1;
			for (let i = 1; i < lines.length; i += 1) {
				if (lines[i]?.trim() === '---') { closingIdx = i; break; }
			}
			expect(closingIdx).toBeGreaterThan(0);
			const bodyAfter = lines.slice(closingIdx + 1).join('\n').trim();
			expect(bodyAfter).toBe('');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('no stop-hook artifacts: settings.local.json and .claude/hooks/ are not created', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-no-hooks-'));
		try {
			const { supervisorFn } = makeFakeSupervisor({
				status: 'complete',
				iterations: 1,
				lastOutcome: null,
			});

			await runNext({
				cwd: dir,
				permissionMode: 'bypassPermissions',
				writer: (_cwd2, _body) => '/fake/.claude/cam-loop.local.md',
				workerPaneReader: (_claudeDir) => '%5',
				supervisorFn,
				startedAt: '2026-06-08T12:00:00Z',
				sessionId: 'no-hooks-test',
			});

			// settings.local.json must NOT be written
			expect(existsSync(join(dir, '.claude', 'settings.local.json'))).toBe(false);
			// .claude/hooks/ must NOT be created
			expect(existsSync(join(dir, '.claude', 'hooks'))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('missing worker pane: returns 1 without calling supervisorFn', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-no-pane-'));
		try {
			const { supervisorFn, calls } = makeFakeSupervisor({
				status: 'complete',
				iterations: 0,
				lastOutcome: null,
			});

			const code = await runNext({
				cwd: dir,
				permissionMode: 'bypassPermissions',
				workerPaneReader: (_claudeDir) => null, // no pane allocated
				supervisorFn,
				startedAt: '2026-06-08T12:00:00Z',
				sessionId: 'no-pane',
			});

			expect(code).toBe(1);
			expect(calls).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('state-file write failure: returns 1 without calling supervisorFn', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-writer-fail-'));
		try {
			const { supervisorFn, calls } = makeFakeSupervisor({
				status: 'complete',
				iterations: 0,
				lastOutcome: null,
			});

			const code = await runNext({
				cwd: dir,
				permissionMode: 'bypassPermissions',
				writer: () => { throw new Error('disk full'); },
				workerPaneReader: (_claudeDir) => '%5',
				supervisorFn,
				startedAt: '2026-06-08T12:00:00Z',
				sessionId: 'writer-fail',
			});

			expect(code).toBe(1);
			expect(calls).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('supervisor blocked: returns 1', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-blocked-'));
		try {
			const { supervisorFn } = makeFakeSupervisor({
				status: 'blocked',
				iterations: 3,
				lastOutcome: null,
			});

			const code = await runNext({
				cwd: dir,
				permissionMode: 'bypassPermissions',
				writer: (_cwd2, _body) => '/fake/.claude/cam-loop.local.md',
				workerPaneReader: (_claudeDir) => '%5',
				supervisorFn,
				startedAt: '2026-06-08T12:00:00Z',
				sessionId: 'blocked-test',
			});

			expect(code).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('supervisor max-iterations: returns 1', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-maxiter-'));
		try {
			const { supervisorFn } = makeFakeSupervisor({
				status: 'max-iterations',
				iterations: 50,
				lastOutcome: null,
			});

			const code = await runNext({
				cwd: dir,
				permissionMode: 'bypassPermissions',
				writer: (_cwd2, _body) => '/fake/.claude/cam-loop.local.md',
				workerPaneReader: (_claudeDir) => '%5',
				supervisorFn,
				startedAt: '2026-06-08T12:00:00Z',
				sessionId: 'maxiter-test',
			});

			expect(code).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('supervisor complete: returns 0', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-complete-'));
		try {
			const { supervisorFn } = makeFakeSupervisor({
				status: 'complete',
				iterations: 5,
				lastOutcome: null,
			});

			const code = await runNext({
				cwd: dir,
				permissionMode: 'bypassPermissions',
				writer: (_cwd2, _body) => '/fake/.claude/cam-loop.local.md',
				workerPaneReader: (_claudeDir) => '%5',
				supervisorFn,
				startedAt: '2026-06-08T12:00:00Z',
				sessionId: 'complete-test',
			});

			expect(code).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('passes custom maxIterations to supervisorFn', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-maxiter-custom-'));
		try {
			const { supervisorFn, calls } = makeFakeSupervisor({
				status: 'complete',
				iterations: 1,
				lastOutcome: null,
			});

			await runNext({
				cwd: dir,
				permissionMode: 'bypassPermissions',
				writer: (_cwd2, _body) => '/fake/.claude/cam-loop.local.md',
				workerPaneReader: (_claudeDir) => '%5',
				supervisorFn,
				maxIterations: 10,
				startedAt: '2026-06-08T12:00:00Z',
				sessionId: 'custom-iter',
			});

			expect(calls[0]!.opts.maxIterations).toBe(10);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('concurrency guard: another live supervisor -> returns 1 without dispatching', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-lock-busy-'));
		try {
			const { supervisorFn, calls } = makeFakeSupervisor({
				status: 'complete',
				iterations: 0,
				lastOutcome: null,
			});

			const code = await runNext({
				cwd: dir,
				permissionMode: 'bypassPermissions',
				writer: (_cwd2, _body) => '/fake/.claude/cam-loop.local.md',
				workerPaneReader: (_claudeDir) => '%5',
				supervisorFn,
				acquireLock: () => ({ acquired: false, holderPid: 4242 }),
				onShutdown: () => {},
				startedAt: '2026-06-08T12:00:00Z',
				sessionId: 'lock-busy',
			});

			expect(code).toBe(1);
			expect(calls).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('concurrency guard: lock released on normal exit and handed to shutdown registrar', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-lock-release-'));
		try {
			const { supervisorFn } = makeFakeSupervisor({
				status: 'complete',
				iterations: 1,
				lastOutcome: null,
			});

			let released = 0;
			const reg: { fn: (() => void) | null } = { fn: null };
			const release = () => {
				released += 1;
			};

			const code = await runNext({
				cwd: dir,
				permissionMode: 'bypassPermissions',
				writer: (_cwd2, _body) => '/fake/.claude/cam-loop.local.md',
				workerPaneReader: (_claudeDir) => '%5',
				supervisorFn,
				acquireLock: () => ({
					acquired: true,
					info: { pid: 1234, startedAt: '2026-06-08T12:00:00Z', project: 'cam-cli' },
					release,
				}),
				onShutdown: (rel) => {
					reg.fn = rel;
				},
				startedAt: '2026-06-08T12:00:00Z',
				sessionId: 'lock-release',
			});

			expect(code).toBe(0);
			// Released at least once on the normal terminal return.
			expect(released).toBeGreaterThanOrEqual(1);
			// The same release fn was handed to the shutdown registrar (AC4).
			expect(reg.fn).toBe(release);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('existing state file causes error without force', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-next-existing-'));
		try {
			mkdirSync(join(dir, '.claude'), { recursive: true });
			require('node:fs').writeFileSync(join(dir, '.claude', 'cam-loop.local.md'), 'old\n');

			const { supervisorFn, calls } = makeFakeSupervisor({
				status: 'complete',
				iterations: 0,
				lastOutcome: null,
			});

			const code = await runNext({
				cwd: dir,
				permissionMode: 'bypassPermissions',
				workerPaneReader: (_claudeDir) => '%5',
				supervisorFn,
				startedAt: '2026-06-08T12:00:00Z',
				sessionId: 'existing',
			});

			expect(code).toBe(1);
			expect(calls).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
