// test/commands/run-boot-prompt-isolation.test.ts
//
// Behavioral test for US-001 (CAM-455): buildOrchestratorBootPrompt must gate
// the "proceed directly into dispatch" instruction on BOTH meta_loop=auto AND
// worker_isolation=container, mirroring the sidecar's own auto-chaining guard
// (src/commands/sidecar.ts:2944-2953). Fixtures are real project.toml files
// written into a real tmpdir; no mocked config reader.
//
// Test names in this file avoid parentheses because `bun test -t` treats its
// argument as a regex, and a literal "(" would need escaping to match.

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildOrchestratorBootPrompt } from '../../src/commands/run.ts';

const DISPATCH_INSTRUCTION = 'proceed directly into dispatch';

function writeProjectToml(dir: string, metaLoop: string, workerIsolation: string): string {
	const path = join(dir, 'project.toml');
	writeFileSync(
		path,
		`[loop]\nmeta_loop = "${metaLoop}"\nworker_isolation = "${workerIsolation}"\n`,
		'utf8',
	);
	return path;
}

describe('orchestrator boot prompt gated on worker_isolation', () => {
	it('omits the dispatch instruction under meta_loop auto with worker_isolation host', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-boot-prompt-isolation-'));
		const configPath = writeProjectToml(dir, 'auto', 'host');
		const prompt = buildOrchestratorBootPrompt(configPath);
		expect(prompt).not.toContain(DISPATCH_INSTRUCTION);
	});

	it('includes the dispatch instruction under meta_loop auto with worker_isolation container', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cam-boot-prompt-isolation-'));
		const configPath = writeProjectToml(dir, 'auto', 'container');
		const prompt = buildOrchestratorBootPrompt(configPath);
		expect(prompt).toContain(DISPATCH_INSTRUCTION);
	});
});
