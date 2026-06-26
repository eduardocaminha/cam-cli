import { test, expect } from 'bun:test';
import { printAutomergeNotice, AUTOMERGE_NOTICE } from '../../src/logging/notices.ts';
import { setQuiet } from '../../src/logging/color.ts';

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

test('printAutomergeNotice() with default writeFn and quiet=false emits the notice', () => {
	const chunks: string[] = [];
	const origWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		if (typeof chunk === 'string') chunks.push(chunk);
		return true;
	}) as typeof process.stdout.write;
	setQuiet(false);
	try {
		printAutomergeNotice();
		expect(chunks.join('')).toContain(AUTOMERGE_NOTICE);
	} finally {
		process.stdout.write = origWrite;
		setQuiet(false);
	}
});

test('printAutomergeNotice() with default writeFn and quiet=true emits nothing', () => {
	const chunks: string[] = [];
	const origWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		if (typeof chunk === 'string') chunks.push(chunk);
		return true;
	}) as typeof process.stdout.write;
	setQuiet(true);
	try {
		printAutomergeNotice();
		expect(chunks).toHaveLength(0);
	} finally {
		process.stdout.write = origWrite;
		setQuiet(false);
	}
});
