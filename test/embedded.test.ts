// test/embedded.test.ts
//
// US-011 acceptance criterion 4: `./dist/cam-darwin-arm64 init` runs the
// validator without erroring. The hard part of "without erroring" in a
// compiled binary is making sure the embedded vendor files
// (`vendor/cam-loop.local.md.tmpl` plus the smoke `.ts`/`.sh` files used
// by `cam init`) are reachable at runtime.
//
// Because we use a codegen step (`scripts/generate-embedded-vendor.ts`)
// rather than runtime reads, the in-process `readEmbedded()` API behaves
// identically in dev and compiled modes — both branches read from the same
// inlined string constants in `src/vendor/_generated.ts`. So testing dev
// mode here is sufficient; the compiled-binary equivalent is exercised once
// at release time via `scripts/build-release.sh` (which runs
// `./dist/cam-darwin-arm64 init` against a tmp config).
//
// What we cover:
//   1. The codegen output is byte-for-byte identical to the on-disk vendor
//      files. Catches a stale `_generated.ts` that wasn't re-run after a
//      vendor edit.
//   2. `readEmbedded()` returns the contents for every key in the union.
//   3. `materializeEmbedded()` extracts to a tempdir and is idempotent;
//      a re-call doesn't rewrite the file (same size → reuse).
//   4. The materialized file's contents match the embedded contents.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
	EMBEDDED_CONTENTS,
	materializeEmbedded,
	readEmbedded,
	type EmbeddedKey,
} from '../src/vendor/embedded.ts';
import { templatesContents } from '../src/templates/embedded.ts';

const VENDOR_KEYS: readonly EmbeddedKey[] = [
	'cam-loop.local.md.tmpl',
	'cam-loop-stop-hook.sh',
	'check-agent-frontmatter.ts',
	'check-agent-frontmatter.sh',
];

const VENDOR_DIR = resolve(import.meta.dir, '..', 'vendor');

describe('EMBEDDED_CONTENTS — codegen byte-parity', () => {
	for (const key of VENDOR_KEYS) {
		test(`${key} matches vendor/${key} byte-for-byte`, () => {
			const fromCodegen = EMBEDDED_CONTENTS[key];
			const fromDisk = readFileSync(join(VENDOR_DIR, key), 'utf8');
			expect(fromCodegen).toBe(fromDisk);
		});
	}

	test('contains exactly the four embedded files (US-011 originals + US-002 stop hook)', () => {
		// If you add an embedded asset, update this list AND the
		// `VENDOR_KEYS` array above. Locking the set down here catches a
		// stray entry that would bloat the binary without intent.
		expect(Object.keys(EMBEDDED_CONTENTS).sort()).toEqual([
			'cam-loop-stop-hook.sh',
			'cam-loop.local.md.tmpl',
			'check-agent-frontmatter.sh',
			'check-agent-frontmatter.ts',
		]);
	});
});

describe('readEmbedded', () => {
	test('returns the template body byte-for-byte', () => {
		const fromEmbedded = readEmbedded('cam-loop.local.md.tmpl');
		const fromDisk = readFileSync(join(VENDOR_DIR, 'cam-loop.local.md.tmpl'), 'utf8');
		expect(fromEmbedded).toBe(fromDisk);
		// Spot-check the placeholder grammar so a sloppy template edit
		// (renaming `{{MAX_ITERATIONS}}` to something `next.ts` doesn't
		// substitute) is caught here, not at first compiled-binary run.
		expect(fromEmbedded).toContain('{{MAX_ITERATIONS}}');
		expect(fromEmbedded).toContain('{{COMPLETION_PROMISE_YAML}}');
		expect(fromEmbedded).toContain('{{PROMPT}}');
	});

	test('returns non-empty contents for every key', () => {
		for (const key of VENDOR_KEYS) {
			const contents = readEmbedded(key);
			expect(contents.length).toBeGreaterThan(0);
		}
	});
});

describe('templatesContents — codegen byte-parity', () => {
	test('matches every file under templates/ byte-for-byte', () => {
		const TEMPLATES_DIR = resolve(import.meta.dir, '..', 'templates');
		// Walk templates/ on disk and compare to the codegen map.
		const walk = (root: string, base = ''): string[] => {
			const out: string[] = [];
			for (const entry of readdirSync(join(root, base))) {
				const rel = base ? `${base}/${entry}` : entry;
				const abs = join(root, rel);
				if (statSync(abs).isDirectory()) out.push(...walk(root, rel));
				else out.push(rel);
			}
			return out.sort();
		};
		const onDisk = walk(TEMPLATES_DIR);
		const fromCodegen = Object.keys(templatesContents).sort();
		expect(fromCodegen).toEqual(onDisk);
		for (const rel of onDisk) {
			expect(templatesContents[rel]).toBe(readFileSync(join(TEMPLATES_DIR, rel), 'utf8'));
		}
	});
});

describe('materializeEmbedded', () => {
	let cacheDir: string;
	let prevCache: string | undefined;

	beforeEach(() => {
		cacheDir = mkdtempSync(join(tmpdir(), 'cam-embedded-test-'));
		prevCache = process.env['CAM_VENDOR_CACHE_DIR'];
		process.env['CAM_VENDOR_CACHE_DIR'] = cacheDir;
	});

	afterEach(() => {
		if (prevCache === undefined) {
			delete process.env['CAM_VENDOR_CACHE_DIR'];
		} else {
			process.env['CAM_VENDOR_CACHE_DIR'] = prevCache;
		}
		if (cacheDir && existsSync(cacheDir)) {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});

	test('writes the embedded contents to the cache dir', () => {
		const path = materializeEmbedded('check-agent-frontmatter.ts');
		expect(existsSync(path)).toBe(true);
		expect(path).toBe(join(cacheDir, 'check-agent-frontmatter.ts'));
		expect(readFileSync(path, 'utf8')).toBe(readEmbedded('check-agent-frontmatter.ts'));
	});

	test('is idempotent — same path on a repeat call', () => {
		const a = materializeEmbedded('check-agent-frontmatter.ts');
		const b = materializeEmbedded('check-agent-frontmatter.ts');
		expect(a).toBe(b);
	});

	test('reuses the cached file when sizes match (no re-extract)', () => {
		const path = materializeEmbedded('check-agent-frontmatter.ts');
		const mtimeBefore = statSync(path).mtimeMs;
		// Wait a tick so a re-extract would visibly bump mtime.
		const start = Date.now();
		while (Date.now() - start < 5) {
			// busy-wait
		}
		materializeEmbedded('check-agent-frontmatter.ts');
		const mtimeAfter = statSync(path).mtimeMs;
		expect(mtimeAfter).toBe(mtimeBefore);
	});

	test('re-extracts when the cached file has been corrupted (size mismatch)', () => {
		const path = materializeEmbedded('check-agent-frontmatter.ts');
		writeFileSync(path, 'corrupted', 'utf8');
		const re = materializeEmbedded('check-agent-frontmatter.ts');
		expect(re).toBe(path);
		expect(readFileSync(re, 'utf8')).toBe(readEmbedded('check-agent-frontmatter.ts'));
	});

	test('materializes every key without error', () => {
		for (const key of VENDOR_KEYS) {
			const path = materializeEmbedded(key);
			expect(existsSync(path)).toBe(true);
			expect(readFileSync(path, 'utf8')).toBe(readEmbedded(key));
		}
	});
});
