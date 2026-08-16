import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verify } from '../scripts/vendor-coss.ts';
import { createTestTmpdir } from './helpers/test-tmpdir.ts';

describe('verify roots', () => {
	test('fails closed for missing and non-directory roots', () => {
		const parent = createTestTmpdir('gship-vendor-coss-invalid-root-');
		const missingRoot = join(parent, 'missing');
		const fileRoot = join(parent, 'file.ts');
		writeFileSync(fileRoot, 'export const value = true;\n');

		expect(() => verify(missingRoot)).toThrow();
		expect(() => verify(fileRoot)).toThrow(
			`COSS vendor verification root is not a directory: ${fileRoot}`,
		);
	});
});
