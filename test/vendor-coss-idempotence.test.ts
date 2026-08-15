import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
	vendorCoss,
	VendorVerificationError,
	type VendorSourceFile,
} from '../scripts/vendor-coss.ts';
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

	test('leaves an existing destination byte-identical when replacement verification fails', () => {
		const parent = createTestTmpdir('cam-vendor-coss-existing-failure-');
		const destination = join(parent, 'coss');
		const cleanFiles: readonly VendorSourceFile[] = [
			{
				relPath: 'components/clean.tsx',
				content: 'import React from "react";\nexport default React;\n',
			},
			{ relPath: 'shared.ts', content: 'export const shared = true;\n' },
		];
		const poisonedFiles: readonly VendorSourceFile[] = [
			{
				relPath: 'components/poisoned.tsx',
				content: 'import component from "@coss/ui";\nexport default component;\n',
			},
		];

		vendorCoss({ destination, fetchFiles: () => cleanFiles });
		const cleanComponent = readFileSync(join(destination, 'components', 'clean.tsx'));
		const cleanShared = readFileSync(join(destination, 'shared.ts'));

		expect(() => vendorCoss({ destination, fetchFiles: () => poisonedFiles })).toThrow(
			VendorVerificationError,
		);
		expect(readFileSync(join(destination, 'components', 'clean.tsx'))).toEqual(cleanComponent);
		expect(readFileSync(join(destination, 'shared.ts'))).toEqual(cleanShared);
		expect(readdirSync(parent)).toEqual(['coss']);
	});
});
