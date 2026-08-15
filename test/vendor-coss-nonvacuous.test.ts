import { expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runCli, vendorCoss, verify } from '../scripts/vendor-coss.ts';
import { createTestTmpdir } from './helpers/test-tmpdir.ts';

test('vendorCoss rejects an empty fetch without creating the destination or staging residue', () => {
	const parent = createTestTmpdir('cam-vendor-coss-empty-fetch-');
	const destination = join(parent, 'coss');

	expect(() => vendorCoss({ destination, fetchFiles: () => [] })).toThrow(
		'COSS vendor source set is empty',
	);

	expect(existsSync(destination)).toBe(false);
	expect(
		readdirSync(parent).filter((entry) => entry.startsWith(`${basename(destination)}.staging-`)),
	).toEqual([]);
});

test('verify and its CLI adapter reject a root without source files', () => {
	const root = createTestTmpdir('cam-vendor-coss-empty-root-');
	const messages: string[] = [];

	expect(() => verify(root)).toThrow(`COSS vendor verification found no source files: ${root}`);
	expect(runCli(['--verify', root], (message) => messages.push(message))).toBe(1);
	expect(messages).toEqual([`COSS vendor verification found no source files: ${root}`]);
});
