// test/commands/run-boot-prompt-isolation.test.ts
//
// Invariance oracle: buildOrchestratorBootPrompt() must return byte-identical
// output regardless of meta_loop / worker_isolation config. The meta_loop
// interpolation was deleted because the persisted prompt file
// (.claude/.cam-orchestrator-prompt.txt) is written once by setupPanes and
// re-read verbatim on every respawn, so any config-derived content in it goes
// stale silently (measured: ed10586b flipped meta_loop 33 minutes after the
// file was written, and the stale text was served for 4 days). The greeting
// fork now lives solely in the persona (subagent-orchestrator.md), which IS
// reloaded on every respawn via --agent; see
// test/templates/orchestrator-boot.test.ts for the persona-side pin.
//
// Fixtures are real project.toml files written into a real tmpdir; no mocked
// config reader. Test names avoid parentheses because `bun test -t` treats
// its argument as a regex.

import { describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { createTestTmpdir } from '../helpers/test-tmpdir';
import { join } from 'node:path';

import { buildOrchestratorBootPrompt } from '../../src/commands/run.ts';

// Widened alias: the production function takes no config path at all (that is
// the point), but this oracle still feeds four distinct configs so that if a
// configPath parameter is ever reintroduced, the invariance assertion below
// immediately exercises it instead of silently testing nothing.
const buildPrompt: (configPath?: string) => string = buildOrchestratorBootPrompt;

function writeProjectToml(path: string, metaLoop: string, workerIsolation: string): string {
	writeFileSync(
		path,
		`[loop]\nmeta_loop = "${metaLoop}"\nworker_isolation = "${workerIsolation}"\n`,
		'utf8',
	);
	return path;
}

describe('orchestrator boot prompt is config-independent', () => {
	it('returns byte-identical output for every meta_loop x worker_isolation combination', () => {
		const dir = createTestTmpdir('cam-boot-prompt-isolation-');
		const prompts = [
			['auto', 'container'],
			['auto', 'host'],
			['observe', 'host'],
			['off', 'host'],
		].map(([metaLoop, workerIsolation], i) => {
			const configPath = writeProjectToml(
				join(dir, `project-${i}.toml`),
				metaLoop as string,
				workerIsolation as string,
			);
			return buildPrompt(configPath);
		});
		expect(prompts[1]).toBe(prompts[0] as string);
		expect(prompts[2]).toBe(prompts[0] as string);
		expect(prompts[3]).toBe(prompts[0] as string);
	});
});
