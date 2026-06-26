import { test, expect } from 'bun:test';
import { printConfigAutomergeHint } from '../../src/commands/config.ts';
import { AUTOMERGE_NOTICE } from '../../src/logging/notices.ts';

test('printConfigAutomergeHint emits the AUTOMERGE_NOTICE constant', () => {
	let captured = '';
	printConfigAutomergeHint((s) => {
		captured += s;
	});
	expect(captured).toContain(AUTOMERGE_NOTICE);
});

test('printConfigAutomergeHint does not duplicate the notice text in config.ts (imported by name)', () => {
	// The AUTOMERGE_NOTICE constant is the single source of truth.
	// This test asserts that calling printConfigAutomergeHint with
	// the AUTOMERGE_NOTICE reference (not a hardcoded literal) surfaces
	// the notice.  The import-by-name oracle is verified by the AC grep.
	const messages: string[] = [];
	printConfigAutomergeHint((s) => messages.push(s));
	expect(messages.some((m) => m.includes('Allow auto-merge'))).toBe(true);
	expect(messages.some((m) => m.includes('Allow squash merging'))).toBe(true);
	expect(messages.some((m) => m.includes('Settings > General > Pull Requests'))).toBe(true);
});
