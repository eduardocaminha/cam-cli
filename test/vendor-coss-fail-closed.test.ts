import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
	vendorCoss,
	VendorVerificationError,
	type VendorSourceFile,
} from '../scripts/vendor-coss.ts';
import { createTestTmpdir } from './helpers/test-tmpdir.ts';

function stagingSiblings(destination: string, parent: string): string[] {
	const prefix = `${basename(destination)}.staging-`;
	return readdirSync(parent).filter((entry) => entry.startsWith(prefix));
}

describe('vendorCoss', () => {
	test('rejects poisoned source without leaving a destination or staging residue', () => {
		const parent = createTestTmpdir('cam-vendor-coss-fail-closed-');
		const destination = join(parent, 'vendor', 'coss');
		const files: readonly VendorSourceFile[] = [
			{
				relPath: 'components/poisoned.tsx',
				content: 'import component from "@coss/ui";\nexport default component;\n',
			},
		];

		expect(() => vendorCoss({ destination, fetchFiles: () => files })).toThrow(
			VendorVerificationError,
		);

		expect(existsSync(destination)).toBe(false);
		expect(stagingSiblings(destination, join(parent, 'vendor'))).toEqual([]);
	});

	test('promotes a fully written clean source tree', () => {
		const parent = createTestTmpdir('cam-vendor-coss-promote-');
		const destination = join(parent, 'vendor', 'coss');
		const files: readonly VendorSourceFile[] = [
			{
				relPath: 'components/clean.tsx',
				content: 'import React from "react";\nimport "../shared";\nexport default React;\n',
			},
			{ relPath: 'shared.ts', content: 'export const shared = true;\n' },
		];

		vendorCoss({ destination, fetchFiles: () => files });

		expect(readFileSync(join(destination, 'components', 'clean.tsx'), 'utf8')).toBe(
			'import React from "react";\nimport "../shared";\nexport default React;\n',
		);
		expect(readFileSync(join(destination, 'shared.ts'), 'utf8')).toBe(
			'export const shared = true;\n',
		);
		expect(stagingSiblings(destination, join(parent, 'vendor'))).toEqual([]);
	});
});
