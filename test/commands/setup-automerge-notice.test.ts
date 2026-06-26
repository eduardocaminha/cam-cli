import { test, expect } from 'bun:test';
import { printAutomergeNotice, AUTOMERGE_NOTICE } from '../../src/logging/notices.ts';

test('printAutomergeNotice writes output containing AUTOMERGE_NOTICE', () => {
	let captured = '';
	printAutomergeNotice((s) => {
		captured += s;
	});
	expect(captured).toContain(AUTOMERGE_NOTICE);
});

test('AUTOMERGE_NOTICE mentions Allow auto-merge, Allow squash merging, and Settings > General > Pull Requests', () => {
	expect(AUTOMERGE_NOTICE).toContain('Allow auto-merge');
	expect(AUTOMERGE_NOTICE).toContain('Allow squash merging');
	expect(AUTOMERGE_NOTICE).toContain('Settings > General > Pull Requests');
});
