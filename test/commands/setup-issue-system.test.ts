// test/commands/setup-issue-system.test.ts
//
// Unit tests for parseSetupArgs() --issue-system flag (src/commands/setup.ts),
// specifically the deprecated 'none' -> 'local' alias.
//
// AC-1: parseSetupArgs maps 'none' to issueSystem 'local' in both argument
//        forms (`--issue-system none` and `--issue-system=none`).
//        [oracle: bun test]
// AC-2: Truly-invalid values (e.g. 'jira') still fail loud: printError plus
//        null return. [oracle: bun test]
//
// US-002 (CAM-239).

import { describe, expect, test } from 'bun:test';

describe('parseSetupArgs --issue-system deprecated none alias', () => {
	test('--issue-system none resolves to local', async () => {
		const { parseSetupArgs } = await import('../../src/commands/setup.ts');
		const result = parseSetupArgs(['--issue-system', 'none', '--no-tmux']);
		expect(result).not.toBeNull();
		expect(result?.issueSystem).toBe('local');
	});

	test('--issue-system=none (equals form) resolves to local', async () => {
		const { parseSetupArgs } = await import('../../src/commands/setup.ts');
		const result = parseSetupArgs(['--issue-system=none']);
		expect(result).not.toBeNull();
		expect(result?.issueSystem).toBe('local');
	});

	test('--issue-system jira (truly invalid) still returns null', async () => {
		const { parseSetupArgs } = await import('../../src/commands/setup.ts');
		const result = parseSetupArgs(['--issue-system', 'jira']);
		expect(result).toBeNull();
	});

	test('--issue-system=jira (equals form, truly invalid) still returns null', async () => {
		const { parseSetupArgs } = await import('../../src/commands/setup.ts');
		const result = parseSetupArgs(['--issue-system=jira']);
		expect(result).toBeNull();
	});

	test('--issue-system local (canonical value) is still accepted', async () => {
		const { parseSetupArgs } = await import('../../src/commands/setup.ts');
		const result = parseSetupArgs(['--issue-system', 'local']);
		expect(result).not.toBeNull();
		expect(result?.issueSystem).toBe('local');
	});
});
