import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { vendorCoss, type VendorSourceFile } from '../scripts/vendor-coss.ts';
import { createTestTmpdir } from './helpers/test-tmpdir.ts';

describe('vendorCoss idempotence', () => {
	test('replaces an existing destination without changing content or leaving sibling residue', () => {
		const parent = createTestTmpdir('cam-vendor-coss-idempotence-');
		const destination = join(parent, 'coss');
		const files: readonly VendorSourceFile[] = [
			{
				relPath: 'components/clean.tsx',
				content: 'import React from "react";\nexport default React;\n',
			},
			{ relPath: 'shared.ts', content: 'export const shared = true;\n' },
		];

		vendorCoss({ destination, fetchFiles: () => files });
		const firstContent = {
			component: readFileSync(join(destination, 'components', 'clean.tsx'), 'utf8'),
			shared: readFileSync(join(destination, 'shared.ts'), 'utf8'),
		};

		expect(() => vendorCoss({ destination, fetchFiles: () => files })).not.toThrow();
		expect({
			component: readFileSync(join(destination, 'components', 'clean.tsx'), 'utf8'),
			shared: readFileSync(join(destination, 'shared.ts'), 'utf8'),
		}).toEqual(firstContent);
		expect(readdirSync(parent)).toEqual(['coss']);
	});
});
