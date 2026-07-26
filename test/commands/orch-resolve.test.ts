// test/commands/orch-resolve.test.ts
//
// Unit tests for `cam orch-resolve` (US-001, CAM-425): a deterministic
// {model, backend, effort} resolver for the orchestrator wrapper.
//
// Coverage:
//   AC1: success prints exactly ONE JSON line to stdout and returns 0; a
//        not-ok model resolution returns 1, prints the resolution message to
//        stderr, and prints NOTHING to stdout. configPath, cacheReader, and
//        the event sink (logEvent) are all injectable seams.
//   AC2: every test resolves against a STAGED temp project.toml passed
//        through the configPath seam, never the live scripts/cam/project.toml
//        (the CAM-405/CAM-420 live-config hazard). A staged
//        efforts.orchestrator = 'max' proves the config value wins over
//        EFFORT_DEFAULTS.orchestrator ('xhigh').
//   AC3: a spawn-resolution event carrying {phase, model, backend, effort}
//        is emitted on every successful resolution (never on failure),
//        asserted via an in-memory event sink; the production default wires
//        through makeFileEventLogger to a real file on disk.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runOrchResolve } from '../../src/commands/orch-resolve.ts';
import { makeInMemoryEventLogger } from '../../src/supervisor/events.ts';
import type { CodexModelsCacheReader } from '../../src/config/codex-models-cache.ts';

/** Stage a temp dir with a project.toml at `<dir>/project.toml`; caller removes it. */
function stageConfig(toml: string): { dir: string; configPath: string } {
	const dir = mkdtempSync(join(tmpdir(), 'cam-orch-resolve-'));
	const configPath = join(dir, 'project.toml');
	writeFileSync(configPath, toml, 'utf8');
	return { dir, configPath };
}

/** Collect writer output into an array of chunks, mirroring options.write shape. */
function collector(): { write: (s: string) => void; chunks: string[] } {
	const chunks: string[] = [];
	return { write: (s: string) => chunks.push(s), chunks };
}

describe('runOrchResolve (US-001, CAM-425)', () => {
	test('AC1: claude success prints exactly one JSON line and returns 0', () => {
		const { dir, configPath } = stageConfig('backend = "claude"\n\n[models]\norchestrator = "opus"\n');
		try {
			const stdout = collector();
			const stderr = collector();
			const code = runOrchResolve({ configPath, write: stdout.write, writeError: stderr.write });

			expect(code).toBe(0);
			expect(stdout.chunks.length).toBe(1);
			const line = stdout.chunks[0] ?? '';
			expect(JSON.parse(line)).toEqual({ model: 'opus', backend: 'claude', effort: 'xhigh' });
			expect(stderr.chunks.length).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('AC2: staged efforts.orchestrator = "max" wins over EFFORT_DEFAULTS.orchestrator ("xhigh")', () => {
		const { dir, configPath } = stageConfig(
			'backend = "claude"\n\n[models]\norchestrator = "opus"\n\n[efforts]\norchestrator = "max"\n',
		);
		try {
			const stdout = collector();
			const code = runOrchResolve({ configPath, write: stdout.write, writeError: () => {} });

			expect(code).toBe(0);
			const line = stdout.chunks[0] ?? '';
			expect(JSON.parse(line)).toEqual({ model: 'opus', backend: 'claude', effort: 'max' });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('AC1: not-ok claude model resolution returns 1, message on stderr, nothing on stdout', () => {
		const { dir, configPath } = stageConfig('backend = "claude"\n\n[models]\norchestrator = "sonnett"\n');
		try {
			const stdout = collector();
			const stderr = collector();
			const code = runOrchResolve({ configPath, write: stdout.write, writeError: stderr.write });

			expect(code).toBe(1);
			expect(stdout.chunks.length).toBe(0);
			expect(stderr.chunks.join('')).toContain("not a recognized claude model");
			expect(stderr.chunks.join('')).toContain('sonnett');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('AC3: successful resolution emits a spawn-resolution event {phase, model, backend, effort} via the injected sink', () => {
		const { dir, configPath } = stageConfig(
			'backend = "claude"\n\n[models]\norchestrator = "opus"\n\n[efforts]\norchestrator = "high"\n',
		);
		try {
			const { logger, events } = makeInMemoryEventLogger();
			const code = runOrchResolve({
				configPath,
				logEvent: logger,
				write: () => {},
				writeError: () => {},
			});

			expect(code).toBe(0);
			expect(events.length).toBe(1);
			expect(events[0]?.kind).toBe('spawn-resolution');
			expect(events[0]?.detail).toEqual({
				phase: 'orchestrator',
				model: 'opus',
				backend: 'claude',
				effort: 'high',
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('AC3: a failed resolution emits NO spawn-resolution event', () => {
		const { dir, configPath } = stageConfig('backend = "claude"\n\n[models]\norchestrator = "sonnett"\n');
		try {
			const { logger, events } = makeInMemoryEventLogger();
			const code = runOrchResolve({
				configPath,
				logEvent: logger,
				write: () => {},
				writeError: () => {},
			});

			expect(code).toBe(1);
			expect(events.length).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('AC3: the production default logEvent seam writes the event through makeFileEventLogger to a real file', () => {
		const { dir, configPath } = stageConfig('backend = "claude"\n\n[models]\norchestrator = "opus"\n');
		try {
			// logEvent intentionally omitted: exercise the default wiring, which
			// derives the event-log path from `cwd` (a separate temp dir so this
			// test never touches the repo's own .claude/cam-worker-events.jsonl).
			const code = runOrchResolve({ configPath, cwd: dir, write: () => {}, writeError: () => {} });
			expect(code).toBe(0);

			const eventLogPath = join(dir, '.claude', 'cam-worker-events.jsonl');
			const lines = readFileSync(eventLogPath, 'utf8').trim().split('\n');
			expect(lines.length).toBe(1);
			const parsed = JSON.parse(lines[0] ?? '{}') as { kind: string; detail: Record<string, unknown> };
			expect(parsed.kind).toBe('spawn-resolution');
			expect(parsed.detail).toEqual({ phase: 'orchestrator', model: 'opus', backend: 'claude', effort: 'xhigh' });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('AC1/AC5: cacheReader seam resolves a codex-backed claude-shaped flat pin via the injected reader', () => {
		const { dir, configPath } = stageConfig('backend = "codex"\n\n[models]\norchestrator = "sonnet"\n');
		try {
			const stdout = collector();
			let cacheReaderCalled = false;
			const cacheReader: CodexModelsCacheReader = () => {
				cacheReaderCalled = true;
				return { ok: true, slug: 'gpt-5.6-sol' };
			};

			const code = runOrchResolve({
				configPath,
				cacheReader,
				write: stdout.write,
				writeError: () => {},
			});

			expect(code).toBe(0);
			expect(cacheReaderCalled).toBe(true);
			const line = stdout.chunks[0] ?? '';
			expect(JSON.parse(line)).toEqual({ model: 'gpt-5.6-sol', backend: 'codex', effort: 'xhigh' });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('AC1/AC5: cacheReader failure returns 1, message on stderr, nothing on stdout, no event emitted', () => {
		const { dir, configPath } = stageConfig('backend = "codex"\n\n[models]\norchestrator = "sonnet"\n');
		try {
			const stdout = collector();
			const stderr = collector();
			const { logger, events } = makeInMemoryEventLogger();
			const cacheReader: CodexModelsCacheReader = () => ({ ok: false, reason: 'models_cache.json missing' });

			const code = runOrchResolve({
				configPath,
				cacheReader,
				logEvent: logger,
				write: stdout.write,
				writeError: stderr.write,
			});

			expect(code).toBe(1);
			expect(stdout.chunks.length).toBe(0);
			expect(stderr.chunks.join('')).toContain('models_cache.json missing');
			expect(events.length).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
