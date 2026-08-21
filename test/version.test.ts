// test/version.test.ts
//
// US-011 acceptance criterion 3: `--version` prints `gateship X.Y.Z`
// The product name is Gateship, not the retired `cam` invocation.
//
// GSHIP-665: there is no manually bumped release literal anymore. Every
// local, package and ordinary-CI build reports the development sentinel
// `0.0.0-dev`; only a native or container release build, compiled with the
// `GSHIP_RELEASE_VERSION` define (scripts/build-release.sh, Dockerfile),
// reports the real released version. Coverage here is:
//   1. `GSHIP_VERSION` is the development sentinel under `bun test` (no such
//      define exists outside a compiled binary), and stays in parity with
//      `package.json`'s own `version` field.
//   2. `resolveReleaseVersion`, the pure validate-or-default resolver behind
//      that constant, is exercised directly against every define shape a
//      real build could produce.
//   3. The CLI dispatcher in `index.ts` accepts all three idiomatic forms
//      (`--version`, `-v`, bare `version`) and emits exactly the documented
//      shape on stdout, whatever `GSHIP_VERSION` happens to resolve to.

import { describe, expect, test } from 'bun:test';

import { main } from '../index.ts';
import { GSHIP_VERSION, resolveReleaseVersion } from '../src/version.ts';

describe('GSHIP_VERSION constant', () => {
	test('is the development sentinel for every source/package build (GSHIP-665)', () => {
		expect(GSHIP_VERSION).toBe('0.0.0-dev');
	});

	test('stays in parity with package.json (fails the suite on version drift)', async () => {
		const pkg = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as {
			version: string;
		};
		expect(pkg.version).toBe(GSHIP_VERSION);
	});
});

describe('resolveReleaseVersion (GSHIP-665)', () => {
	test('no compile-time define resolves to the development sentinel', () => {
		expect(resolveReleaseVersion(undefined)).toBe('0.0.0-dev');
	});

	test('a blank define (an unset build-arg) also resolves to the development sentinel', () => {
		expect(resolveReleaseVersion('')).toBe('0.0.0-dev');
		expect(resolveReleaseVersion('   ')).toBe('0.0.0-dev');
	});

	test('a valid MAJOR.MINOR.PATCH define is used verbatim, trimmed', () => {
		expect(resolveReleaseVersion('1.2.3')).toBe('1.2.3');
		expect(resolveReleaseVersion(' 0.294.0 ')).toBe('0.294.0');
	});

	test('a malformed define throws rather than silently mislabeling the build', () => {
		expect(() => resolveReleaseVersion('v1.2.3')).toThrow();
		expect(() => resolveReleaseVersion('1.2')).toThrow();
		expect(() => resolveReleaseVersion('1.2.3-rc1')).toThrow();
		expect(() => resolveReleaseVersion('not-a-version')).toThrow();
	});
});

describe('gship version variants', () => {
	function captureStdout(): { restore: () => void; written: () => string } {
		const original = process.stdout.write.bind(process.stdout);
		const chunks: string[] = [];
		process.stdout.write = ((chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
			return true;
		}) as typeof process.stdout.write;
		return {
			restore: () => {
				process.stdout.write = original;
			},
			written: () => chunks.join(''),
		};
	}

	test('--version prints `gateship X.Y.Z\\n` and exits 0', async () => {
		const cap = captureStdout();
		try {
			const code = await main(['bun', 'gship', '--version']);
			expect(code).toBe(0);
			expect(cap.written()).toBe(`gateship ${GSHIP_VERSION}\n`);
		} finally {
			cap.restore();
		}
	});

	test('-v alias matches --version', async () => {
		const cap = captureStdout();
		try {
			const code = await main(['bun', 'gship', '-v']);
			expect(code).toBe(0);
			expect(cap.written()).toBe(`gateship ${GSHIP_VERSION}\n`);
		} finally {
			cap.restore();
		}
	});

	test('bare `version` subcommand matches --version', async () => {
		const cap = captureStdout();
		try {
			const code = await main(['bun', 'gship', 'version']);
			expect(code).toBe(0);
			expect(cap.written()).toBe(`gateship ${GSHIP_VERSION}\n`);
		} finally {
			cap.restore();
		}
	});
});
