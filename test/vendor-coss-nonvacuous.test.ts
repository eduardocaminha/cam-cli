import { expect, test } from 'bun:test';
import { runCli, verify } from '../scripts/vendor-coss.ts';
import { createTestTmpdir } from './helpers/test-tmpdir.ts';

test('verify and its CLI adapter reject a root without source files', () => {
	const root = createTestTmpdir('gship-vendor-coss-empty-root-');
	const messages: string[] = [];

	expect(() => verify(root)).toThrow(`COSS vendor verification found no source files: ${root}`);
	expect(runCli(['--verify', root], (message) => messages.push(message))).toBe(1);
	expect(messages).toEqual([`COSS vendor verification found no source files: ${root}`]);
});
