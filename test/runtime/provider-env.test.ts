import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dockerfile = readFileSync(resolve(import.meta.dir, '..', '..', 'Dockerfile'), 'utf8');

describe('container global home environment', () => {
	test('keeps the registry and CLI-owned login stores on stable paths in the one state volume', () => {
		expect(dockerfile).toContain('GATESHIP_HOME=/var/lib/gateship');
		expect(dockerfile).toContain('CLAUDE_CONFIG_DIR=/var/lib/gateship/claude');
		expect(dockerfile).toContain('CODEX_HOME=/var/lib/gateship/codex');
		expect(dockerfile).toContain('GH_CONFIG_DIR=/var/lib/gateship/gh');
		expect(dockerfile).toContain('GIT_CONFIG_GLOBAL=/var/lib/gateship/gitconfig');
	});

	test('does not place global credentials or the product home under a project', () => {
		expect(dockerfile).not.toContain('/workspace/.gship/claude');
		expect(dockerfile).not.toContain('/workspace/.gship/codex');
		expect(dockerfile).not.toContain('/workspace/.gship/gh');
		expect(dockerfile).not.toContain('/workspace/.gship/gitconfig');
	});
});
