// test/supervisor/codex-adapter.test.ts
//
// Argv-shape tests for CodexAdapter.buildSpawnArgv (US-001, CAM-350, ADR-0047
// follow-up implementation). Unlike backend-adapter.test.ts's fully-pinned
// ClaudeAdapter goldens, these assertions can't pin the whole string literally:
// buildSpawnArgv writes a fresh /tmp instructions file on every call (a random
// suffix), so the argv contains a non-deterministic path. Instead: assert the
// fixed structural pieces by substring/regex, extract the tmpfile path, and
// verify its on-disk contents independently.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { CodexAdapter } from '../../src/supervisor/backend-adapter.ts';

const SAMPLE_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SAMPLE_PROMPT = "Implement it's US-001; use $HOME and `backtick`.";
const SAMPLE_MODE = 'bypassPermissions';

/** Extracts the path passed to `-c model_instructions_file=<path>`. */
function extractInstructionsFile(argv: string): string {
	const match = argv.match(/-c model_instructions_file=(\S+)/);
	if (!match?.[1]) throw new Error(`no model_instructions_file found in argv: ${argv}`);
	return match[1];
}

describe('CodexAdapter.buildSpawnArgv (US-001)', () => {
	for (const actor of ['implementer', 'planner', 'auditor', 'reviewer'] as const) {
		test(`${actor}: emits a codex exec command`, () => {
			const adapter = new CodexAdapter();
			const opts =
				actor === 'reviewer'
					? { uuid: SAMPLE_UUID }
					: { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: SAMPLE_MODE };
			const actual = adapter.buildSpawnArgv(actor, opts);
			expect(actual).toContain('codex exec');
		});

		test(`${actor}: uses --dangerously-bypass-approvals-and-sandbox for bypassPermissions`, () => {
			const adapter = new CodexAdapter();
			const opts =
				actor === 'reviewer'
					? { uuid: SAMPLE_UUID, permissionMode: 'bypassPermissions' }
					: { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: 'bypassPermissions' };
			const actual = adapter.buildSpawnArgv(actor, opts);
			expect(actual).toContain('--dangerously-bypass-approvals-and-sandbox');
			expect(actual).not.toContain('--ask-for-approval');
			expect(actual).not.toContain('--sandbox');
		});

		test(`${actor}: uses --sandbox workspace-write --ask-for-approval never for a non-bypass permissionMode`, () => {
			const adapter = new CodexAdapter();
			const opts =
				actor === 'reviewer'
					? { uuid: SAMPLE_UUID, permissionMode: 'acceptEdits' }
					: { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: 'acceptEdits' };
			const actual = adapter.buildSpawnArgv(actor, opts);
			expect(actual).toContain('--sandbox workspace-write');
			expect(actual).toContain('--ask-for-approval never');
			expect(actual).not.toContain('--dangerously-bypass-approvals-and-sandbox');
		});

		test(`${actor}: passes -m <model> from opts.model`, () => {
			const adapter = new CodexAdapter();
			const opts =
				actor === 'reviewer'
					? { uuid: SAMPLE_UUID, model: 'gpt-5.4-codex' }
					: {
							uuid: SAMPLE_UUID,
							taskPrompt: SAMPLE_PROMPT,
							permissionMode: SAMPLE_MODE,
							model: 'gpt-5.4-codex',
						};
			const actual = adapter.buildSpawnArgv(actor, opts);
			expect(actual).toContain("-m 'gpt-5.4-codex'");
		});

		test(`${actor}: -c model_instructions_file points at a /tmp file (never .claude/) holding the frontmatter-stripped agent body`, () => {
			const adapter = new CodexAdapter();
			const opts =
				actor === 'reviewer'
					? { uuid: SAMPLE_UUID }
					: { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT, permissionMode: SAMPLE_MODE };
			const actual = adapter.buildSpawnArgv(actor, opts);
			const instructionsFile = extractInstructionsFile(actual);

			expect(instructionsFile.startsWith('/tmp/')).toBe(true);
			expect(instructionsFile).not.toContain('.claude/');

			const written = readFileSync(instructionsFile, 'utf8');
			const agentFileMap: Record<string, string> = {
				implementer: 'subagent-implementer',
				planner: 'subagent-planner',
				auditor: 'subagent-auditor',
				reviewer: 'subagent-reviewer',
			};
			const raw = readFileSync(`.claude/agents/${agentFileMap[actor]}.md`, 'utf8');
			const expectedBody = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

			expect(written).toBe(expectedBody);
			expect(written.startsWith('---')).toBe(false);
		});
	}

	test('shell-escapes the task prompt (single quotes, embedded quotes/backticks/$)', () => {
		const adapter = new CodexAdapter();
		const actual = adapter.buildSpawnArgv('implementer', {
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(actual).toContain("'Implement it'\\''s US-001; use $HOME and `backtick`.'");
	});

	test('emits NO --session-id flag', () => {
		const adapter = new CodexAdapter();
		const actual = adapter.buildSpawnArgv('implementer', {
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(actual).not.toContain('--session-id');
		expect(actual).not.toContain(SAMPLE_UUID);
	});

	test('emits NO claude-style CLAUDECODE nesting-guard env strip', () => {
		const adapter = new CodexAdapter();
		const actual = adapter.buildSpawnArgv('implementer', {
			uuid: SAMPLE_UUID,
			taskPrompt: SAMPLE_PROMPT,
			permissionMode: SAMPLE_MODE,
		});
		expect(actual).not.toContain('CLAUDECODE');
	});

	test('reviewer: all-defaults path (no taskPrompt/permissionMode) still renders a full command', () => {
		const adapter = new CodexAdapter();
		const actual = adapter.buildSpawnArgv('reviewer', { uuid: SAMPLE_UUID });
		expect(actual).toContain('codex exec');
		expect(actual).toContain('--dangerously-bypass-approvals-and-sandbox');
		expect(actual).toContain("-m 'opus'");
	});

	test('implementer/planner/auditor throw when taskPrompt is missing (never silently emits a bad argv)', () => {
		const adapter = new CodexAdapter();
		for (const actor of ['implementer', 'planner', 'auditor'] as const) {
			expect(() => adapter.buildSpawnArgv(actor, { uuid: SAMPLE_UUID, permissionMode: SAMPLE_MODE })).toThrow();
		}
	});

	test('implementer/planner/auditor throw when permissionMode is missing', () => {
		const adapter = new CodexAdapter();
		for (const actor of ['implementer', 'planner', 'auditor'] as const) {
			expect(() => adapter.buildSpawnArgv(actor, { uuid: SAMPLE_UUID, taskPrompt: SAMPLE_PROMPT })).toThrow();
		}
	});
});
