// test/version.test.ts
//
// US-011 acceptance criterion 3: `cam --version` prints `cam X.Y.Z`.
//
// Two layers of coverage:
//   1. The exported constant `CAM_VERSION` matches the documented v0.1.0
//      release shape (`MAJOR.MINOR.PATCH`, no pre-release suffix in this
//      first release).
//   2. The CLI dispatcher in `index.ts` accepts all three idiomatic forms
//      (`--version`, `-v`, bare `version`) and emits exactly the documented
//      shape on stdout. We exercise the parser/dispatcher via `main()`
//      rather than a child-process spawn so the test is deterministic and
//      fast (no `bun build`/process boundary).

import { describe, expect, test } from 'bun:test';

import { main } from '../index.ts';
import { CAM_VERSION } from '../src/version.ts';

describe('CAM_VERSION constant', () => {
	test('parses as a clean semver-major.minor.patch literal', () => {
		expect(CAM_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test('is the v0.1.0 first-release shape (or later)', () => {
		// Tripwire: a future bump can adjust this assertion. The point is to
		// make sure nobody accidentally rolls back to 0.0.x once we've
		// shipped v0.1.0.
		const [major, minor] = CAM_VERSION.split('.').map((n) => Number.parseInt(n, 10));
		expect(major).toBeGreaterThanOrEqual(0);
		expect(minor).toBeGreaterThanOrEqual(1);
	});
});

describe('`cam` dispatch — version variants', () => {
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

	test('--version prints `cam X.Y.Z\\n` and exits 0', async () => {
		const cap = captureStdout();
		try {
			const code = await main(['bun', 'cam', '--version']);
			expect(code).toBe(0);
			expect(cap.written()).toBe(`\ncam ${CAM_VERSION}\n\n`);
		} finally {
			cap.restore();
		}
	});

	test('-v alias matches --version', async () => {
		const cap = captureStdout();
		try {
			const code = await main(['bun', 'cam', '-v']);
			expect(code).toBe(0);
			expect(cap.written()).toBe(`\ncam ${CAM_VERSION}\n\n`);
		} finally {
			cap.restore();
		}
	});

	test('bare `version` subcommand matches --version', async () => {
		const cap = captureStdout();
		try {
			const code = await main(['bun', 'cam', 'version']);
			expect(code).toBe(0);
			expect(cap.written()).toBe(`\ncam ${CAM_VERSION}\n\n`);
		} finally {
			cap.restore();
		}
	});
});
