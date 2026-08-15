import { describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	runCli,
	VendorVerificationError,
	verify,
} from '../scripts/vendor-coss.ts';
import { createTestTmpdir } from './helpers/test-tmpdir.ts';

function writeSource(root: string, path: string, source: string): void {
	const destination = join(root, path);
	mkdirSync(join(destination, '..'), { recursive: true });
	writeFileSync(destination, source);
}

function violationsFrom(root: string): readonly string[] {
	try {
		verify(root);
		return [];
	} catch (error) {
		if (!(error instanceof VendorVerificationError)) throw error;
		return error.violations.map(({ specifier }) => specifier);
	}
}

describe('verify', () => {
	test('allows relative imports contained by the root and explicit npm package subpaths', () => {
		const root = createTestTmpdir('cam-vendor-coss-clean-');
		writeSource(
			root,
			'components/progress.tsx',
			[
				'import React from "react";',
				'import { mergeProps } from "@base-ui/react/merge-props";',
				'import { useRender } from "@base-ui/react/use-render";',
				'import { progress } from "@base-ui/react/progress";',
				'import { separator } from "@base-ui/react/separator";',
				'import "../shared";',
				'export const registryDependencies = ["@coss/ui"];',
			].join('\n'),
		);
		writeSource(root, 'shared.ts', 'export const shared = true;\n');

		expect(() => verify(root)).not.toThrow();
	});

	test('rejects AGPL and otherwise unknown bare package specifiers', () => {
		const root = createTestTmpdir('cam-vendor-coss-unknown-');
		writeSource(root, 'agpl.ts', 'import x from "@coss/ui";\n');
		writeSource(root, 'future.ts', 'export { y } from "totally-unlisted-pkg";\n');

		expect(violationsFrom(root)).toEqual(['@coss/ui', 'totally-unlisted-pkg']);
	});

	test('rejects an unknown bare require call in CommonJS source', () => {
		const root = createTestTmpdir('cam-vendor-coss-require-');
		writeSource(root, 'leak.cjs', 'const m = require("@coss/ui");\nmodule.exports = m;\n');
		const messages: string[] = [];

		expect(runCli(['--verify', root], (message) => messages.push(message))).toBe(1);
		expect(messages).toEqual([
			'leak.cjs: import "@coss/ui" specifier is not in the explicit npm allowlist',
		]);
	});

	test('rejects a source file reached through a symbolic link', () => {
		const root = createTestTmpdir('cam-vendor-coss-symlink-root-');
		const targetRoot = createTestTmpdir('cam-vendor-coss-symlink-target-');
		writeSource(targetRoot, 'real/leak.ts', 'import x from "@coss/ui";\n');
		const link = join(root, 'link.ts');
		symlinkSync(join(targetRoot, 'real/leak.ts'), link);
		const messages: string[] = [];

		expect(runCli(['--verify', root], (message) => messages.push(message))).toBe(1);
		expect(messages).toEqual([`COSS vendor verification rejects symbolic link: ${link}`]);
	});

	test('matches allowlisted packages only at an exact or slash-delimited subpath boundary', () => {
		const root = createTestTmpdir('cam-vendor-coss-prefix-');
		writeSource(root, 'prefix.ts', 'import x from "react-dom";\n');
		writeSource(root, 'scoped-prefix.ts', 'import y from "@base-ui/reactive";\n');

		expect(violationsFrom(root)).toEqual(['react-dom', '@base-ui/reactive']);
	});

	test('rejects a relative import that normalizes outside the verified root', () => {
		const root = createTestTmpdir('cam-vendor-coss-relative-');
		writeSource(root, 'nested/leak.ts', 'import x from "../../../outside";\n');

		expect(violationsFrom(root)).toEqual(['../../../outside']);
	});

	test('reports every violation through the CLI adapter', () => {
		const root = createTestTmpdir('cam-vendor-coss-cli-');
		writeSource(root, 'one.ts', 'import x from "@coss/ui";\n');
		writeSource(root, 'two.ts', 'import y from "another-unknown-package";\n');
		const messages: string[] = [];
		expect(runCli(['--verify', root], (message) => messages.push(message))).toBe(1);

		expect(messages).toHaveLength(2);
		expect(messages.join('\n')).toContain('@coss/ui');
		expect(messages.join('\n')).toContain('another-unknown-package');
	});
});
