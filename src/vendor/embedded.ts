// src/vendor/embedded.ts
//
// Public API over the codegenned `_generated.ts` module — the bridge
// between cam-cli's runtime and the vendored smoke files.
//
// Why a codegen rather than a Bun import attribute? See the comment block at
// the top of `scripts/generate-embedded-vendor.ts`. TL;DR: TypeScript
// typechecks `with { type: "text" }` imports of `.ts` files even though the
// loader inlines them as strings, and the vendored copies are guaranteed
// byte-for-byte from the reporter monorepo (different tsconfig). The codegen
// produces a plain TS module with raw string constants — no loader magic,
// works identically in `bun src/...` and `bun build --compile`.
//
// Two helpers:
//   - `readEmbedded(key)`: returns the inlined contents as a UTF-8 string.
//     Use for in-process reads (e.g. `next.ts`'s template renderer).
//   - `materializeEmbedded(key)`: writes the contents to a tempdir and
//     returns the on-disk path. Use when the file must be handed to a
//     child process — the child can't see strings inlined into the parent
//     binary. The tempdir is namespaced by `CAM_VERSION` so a cam-cli
//     upgrade on the same machine doesn't reuse stale extracted files.

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CAM_VERSION } from '../version.ts';
import {
	checkAgentFrontmatterShContents,
	checkAgentFrontmatterTsContents,
	camLoopTmplContents,
} from './_generated.ts';

export type EmbeddedKey =
	| 'cam-loop.local.md.tmpl'
	| 'check-agent-frontmatter.ts'
	| 'check-agent-frontmatter.sh';

/**
 * Mapping of stable basename keys to inlined UTF-8 contents. Each entry is
 * a `string` populated by the codegen step. A typo on the key is caught by
 * TypeScript's literal-string indexing.
 */
export const EMBEDDED_CONTENTS: Record<EmbeddedKey, string> = {
	'cam-loop.local.md.tmpl': camLoopTmplContents,
	'check-agent-frontmatter.ts': checkAgentFrontmatterTsContents,
	'check-agent-frontmatter.sh': checkAgentFrontmatterShContents,
};

/**
 * Read an embedded file's contents as UTF-8. Works identically in dev and
 * compiled modes — the contents were inlined at codegen time.
 */
export function readEmbedded(key: EmbeddedKey): string {
	return EMBEDDED_CONTENTS[key];
}

// --- Materialization for spawn-as-child ------------------------------------

/**
 * Cache directory we extract embedded scripts into for spawn-as-child usage.
 * Versioned so we don't collide across cam-cli upgrades on the same
 * machine. We deliberately use the OS tmpdir rather than `~/.cache/cam`
 * so the cache is wiped on reboot and we never accumulate stale extracted
 * files across upgrades.
 *
 * Override via `CAM_VENDOR_CACHE_DIR` for tests so they don't leak files
 * into the system tmpdir between runs.
 */
function cacheDir(): string {
	const override = process.env['CAM_VENDOR_CACHE_DIR'];
	if (override) return override;
	return join(tmpdir(), `cam-cli-vendor-${CAM_VERSION}`);
}

/**
 * Materialize an embedded file to disk and return its path. Idempotent: if
 * the cached extracted file already exists with the right size, we reuse
 * it.
 *
 * Use this when you need to hand the file to a child process (e.g.
 * `spawnSync('bun', [path])` in `init.ts`'s smoke runner). For in-process
 * reads, use `readEmbedded()` — no disk hit.
 */
export function materializeEmbedded(key: EmbeddedKey): string {
	const dir = cacheDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const target = join(dir, key);
	const contents = EMBEDDED_CONTENTS[key];
	const expectedSize = Buffer.byteLength(contents, 'utf8');

	// Reuse if the cached file already has the same byte size. We don't
	// content-hash because (a) cam-cli ships immutable embedded files and
	// (b) version-namespacing the cache dir already protects us from
	// cross-version drift.
	if (existsSync(target)) {
		try {
			if (statSync(target).size === expectedSize) {
				return target;
			}
		} catch {
			// Fall through to re-extract on stat failure.
		}
	}

	writeFileSync(target, contents, 'utf8');
	return target;
}
