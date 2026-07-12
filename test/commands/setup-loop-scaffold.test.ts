// test/commands/setup-loop-scaffold.test.ts
//
// Verifies the [loop] section scaffold (scaffoldLoopSection, setup.ts):
// cam init documents meta_loop/worker_isolation/orch_context_window as
// COMMENTED examples, without pinning an active value. Tested at the pure
// function level (no runSetup/tmux/Ink/claude side effects), same convention
// as test/commands/setup-models-defaults.test.ts.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scaffoldLoopSection } from '../../src/commands/setup.ts';
import { loadConfig, mergeIntoConfig, parseToml } from '../../src/config/toml.ts';
import {
	readMetaLoop,
	readWorkerIsolation,
	readOrchContextWindow,
	DEFAULT_ORCH_CONTEXT_WINDOW,
} from '../../src/config/models.ts';

let tmpDir: string;
let configPath: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'cam-setup-loop-scaffold-'));
	configPath = join(tmpDir, 'project.toml');
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

// AC1: emits a [loop] section with commented example lines.
test('scaffolds a [loop] section with commented meta_loop/worker_isolation/orch_context_window', () => {
	scaffoldLoopSection(configPath);
	const raw = readFileSync(configPath, 'utf8');
	expect(raw).toMatch(/\[loop\]/);
	expect(raw).toMatch(/#.*meta_loop/);
	expect(raw).toMatch(/#.*worker_isolation/);
	expect(raw).toMatch(/#.*orch_context_window/);
});

// AC2: the commented enums/defaults match the readers exactly.
test('commented lines name the readers\' exact accepted values and default', () => {
	scaffoldLoopSection(configPath);
	const raw = readFileSync(configPath, 'utf8');
	expect(raw).toMatch(/meta_loop.*auto \| observe \| off/);
	expect(raw).toMatch(/worker_isolation.*container \| host/);
	expect(raw).toMatch(/orch_context_window.*200000/);
});

// AC3: keys are commented examples, not active/pinned -- readers still
// return their code defaults against the freshly scaffolded file.
test('readMetaLoop/readWorkerIsolation/readOrchContextWindow return code defaults against the scaffold', () => {
	scaffoldLoopSection(configPath);
	expect(readMetaLoop(configPath)).toBe('off');
	expect(readWorkerIsolation(configPath)).toBe('host');
	expect(readOrchContextWindow(configPath)).toBe(DEFAULT_ORCH_CONTEXT_WINDOW);
});

// AC4: the scaffolded file is valid, parseable TOML, and comments are
// dropped by the parser (non-semantic).
test('parseToml does not throw on the scaffold and drops the comment lines', () => {
	scaffoldLoopSection(configPath);
	const raw = readFileSync(configPath, 'utf8');
	expect(() => parseToml(raw)).not.toThrow();
	const parsed = parseToml(raw);
	const loopSection = parsed['loop'] as Record<string, unknown>;
	expect(typeof loopSection).toBe('object');
	expect(loopSection['meta_loop']).toBeUndefined();
	expect(loopSection['worker_isolation']).toBeUndefined();
	expect(loopSection['orch_context_window']).toBeUndefined();
});

// Idempotency: a second scaffold call (mirroring a re-run of cam init) never
// clobbers a hand-edited [loop] section.
test('is idempotent: does not overwrite an existing [loop] section', () => {
	scaffoldLoopSection(configPath);
	const before = readFileSync(configPath, 'utf8');
	scaffoldLoopSection(configPath);
	const after = readFileSync(configPath, 'utf8');
	expect(after).toBe(before);
});

test('preserves pre-existing config keys written by earlier mergeIntoConfig calls', () => {
	mergeIntoConfig(configPath, { issue_system: 'local', backend: { name: 'claude' } });
	scaffoldLoopSection(configPath);
	const config = loadConfig(configPath);
	expect(config['issue_system']).toBe('local');
	expect((config['backend'] as Record<string, unknown>)['name']).toBe('claude');
});
