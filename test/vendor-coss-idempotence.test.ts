import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
	vendorCoss,
	VendorVerificationError,
	type VendorSourceFile,
} from '../scripts/vendor-coss.ts';
import { createTestTmpdir } from './helpers/test-tmpdir.ts';

describe('vendorCoss idempotence', () => {
	test('replaces an existing destination with the exact next source set', () => {
		const parent = createTestTmpdir('cam-vendor-coss-idempotence-');
		const destination = join(parent, 'coss');
		const initialFiles: readonly VendorSourceFile[] = [
			{
				relPath: 'components/clean.tsx',
				content: 'import React from "react";\nexport default React;\n',
			},
			{ relPath: 'shared.ts', content: 'export const shared = true;\n' },
		];
		const replacementFiles: readonly VendorSourceFile[] = [
			{
				relPath: 'components/clean.tsx',
				content: 'import React from "react";\nexport default React;\n',
			},
			{ relPath: 'added.ts', content: 'export const added = true;\n' },
		];

		vendorCoss({ destination, fetchFiles: () => initialFiles });
		expect(existsSync(join(destination, 'shared.ts'))).toBe(true);

		expect(() =>
			vendorCoss({ destination, fetchFiles: () => replacementFiles }),
		).not.toThrow();
		expect(existsSync(join(destination, 'shared.ts'))).toBe(false);
		expect(existsSync(join(destination, 'added.ts'))).toBe(true);
		expect(readFileSync(join(destination, 'added.ts'), 'utf8')).toBe(
			'export const added = true;\n',
		);
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
