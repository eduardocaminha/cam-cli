// test/commands/status-paused.test.ts
//
// Unit tests for the operator-paused state in `cam status` (US-003, CAM-360).
//
// `operator-paused` reflects the dedicated pause-marker file (`.cam-pause`,
// src/supervisor/pause-marker.ts, US-001) written by `cam pause` — an
// intentional operator brake — and is distinct from the phase-derived
// `paused` state (which reflects `active:false` in the loop's own state
// file, set by the plugin on completion/cancel). This file asserts:
//   - buildStatusReport surfaces `state: 'operator-paused'` when the marker
//     is present, both when the loop state file is absent and when it is
//     present with `active:true`.
//   - the marker takes precedence over the phase-derived `paused` label
//     when the state file has `active:false` too.
//   - the marker is NOT consulted when absent — plain `active`/`paused`
//     states are unaffected.
//   - runStatus's print path renders a visibly distinct indicator + trailing
//     hint for `operator-paused` vs. plain `paused`.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildStatusReport, runStatus } from '../../src/commands/status.ts';
import { setPause } from '../../src/supervisor/pause-marker.ts';

function makeDirs(prefix: string): { cwd: string; claudeDir: string } {
	const base = mkdtempSync(join(tmpdir(), prefix));
	const cwd = join(base, 'project');
	const claudeDir = join(base, 'claude-dir');
	mkdirSync(cwd, { recursive: true });
	mkdirSync(claudeDir, { recursive: true });
	return { cwd, claudeDir };
}

// --- buildStatusReport ------------------------------------------------------

describe('buildStatusReport — operator-paused (US-003)', () => {
	test('marker present + no loop state file -> operator-paused (not idle)', () => {
		const { cwd, claudeDir } = makeDirs('cam-status-oppause-nostate-');
		try {
			setPause(claudeDir);
			const report = buildStatusReport({ cwd, claudeDir });
			expect(report.state).toBe('operator-paused');
		} finally {
			rmSync(join(cwd, '..'), { recursive: true, force: true });
		}
	});

	test('marker present + active:true state file -> operator-paused (not active)', () => {
		const { cwd, claudeDir } = makeDirs('cam-status-oppause-active-');
		try {
			setPause(claudeDir);
			mkdirSync(join(cwd, '.claude'), { recursive: true });
			writeFileSync(
				join(cwd, '.claude', 'cam-loop.local.md'),
				['---', 'active: true', 'iteration: 3', 'max_iterations: 30', '---', ''].join('\n'),
			);
			const report = buildStatusReport({ cwd, claudeDir });
			expect(report.state).toBe('operator-paused');
		} finally {
			rmSync(join(cwd, '..'), { recursive: true, force: true });
		}
	});

	test('marker present + active:false state file -> operator-paused, not the plain paused label', () => {
		const { cwd, claudeDir } = makeDirs('cam-status-oppause-precedence-');
		try {
			setPause(claudeDir);
			mkdirSync(join(cwd, '.claude'), { recursive: true });
			writeFileSync(
				join(cwd, '.claude', 'cam-loop.local.md'),
				['---', 'active: false', 'iteration: 3', 'max_iterations: 30', '---', ''].join('\n'),
			);
			const report = buildStatusReport({ cwd, claudeDir });
			// Precedence: the operator marker wins over the phase-derived 'paused'.
			expect(report.state).toBe('operator-paused');
			expect(report.state).not.toBe('paused');
		} finally {
			rmSync(join(cwd, '..'), { recursive: true, force: true });
		}
	});

	test('marker absent -> plain active/paused states are unaffected', () => {
		const { cwd, claudeDir } = makeDirs('cam-status-oppause-absent-');
		try {
			mkdirSync(join(cwd, '.claude'), { recursive: true });
			writeFileSync(
				join(cwd, '.claude', 'cam-loop.local.md'),
				['---', 'active: true', 'iteration: 3', 'max_iterations: 30', '---', ''].join('\n'),
			);
			const report = buildStatusReport({ cwd, claudeDir });
			expect(report.state).toBe('active');
		} finally {
			rmSync(join(cwd, '..'), { recursive: true, force: true });
		}
	});
});

// --- runStatus (print path) -------------------------------------------------

describe('runStatus — operator-paused print path (US-003)', () => {
	function captureRunStatus(opts: Parameters<typeof runStatus>[0]): string {
		const original = process.stdout.write.bind(process.stdout);
		const chunks: string[] = [];
		process.stdout.write = ((chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			runStatus(opts);
		} finally {
			process.stdout.write = original;
		}
		return chunks.join('');
	}

	test('renders a distinct "operator-paused" indicator + trailing hint, not the plain "paused" label', () => {
		const { cwd, claudeDir } = makeDirs('cam-status-run-oppause-');
		try {
			setPause(claudeDir);
			mkdirSync(join(cwd, '.claude'), { recursive: true });
			writeFileSync(
				join(cwd, '.claude', 'cam-loop.local.md'),
				['---', 'active: false', 'iteration: 3', 'max_iterations: 30', '---', ''].join('\n'),
			);
			const out = captureRunStatus({ cwd, claudeDir });
			expect(out).toMatch(/operator-paused/);
			expect(out).toMatch(/cam resume/);
			// The plain phase-derived hint (from the active:false branch) must
			// NOT also render — the two states are mutually exclusive.
			expect(out).not.toMatch(/active:false in state file/);
			expect(out).not.toMatch(/cam stop.*clear the state file/);
		} finally {
			rmSync(join(cwd, '..'), { recursive: true, force: true });
		}
	});

	test('plain paused (no marker) still renders the original "paused" hint, unaffected', () => {
		const { cwd, claudeDir } = makeDirs('cam-status-run-plainpause-');
		try {
			mkdirSync(join(cwd, '.claude'), { recursive: true });
			writeFileSync(
				join(cwd, '.claude', 'cam-loop.local.md'),
				['---', 'active: false', 'iteration: 3', 'max_iterations: 30', '---', ''].join('\n'),
			);
			const out = captureRunStatus({ cwd, claudeDir });
			expect(out).toMatch(/\bpaused\b/);
			expect(out).not.toMatch(/operator-paused/);
			expect(out).toMatch(/active:false in state file/);
		} finally {
			rmSync(join(cwd, '..'), { recursive: true, force: true });
		}
	});
});
