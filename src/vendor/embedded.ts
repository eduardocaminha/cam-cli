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

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/** Fixed, reused top-level directory name under tmpdir(). */
const VENDOR_CACHE_PARENT_NAME = 'cam-cli-vendor';

/** Sibling version subdirectories older than this are pruned as stale (ms). */
const STALE_VERSION_DIR_AGE_MS = 60 * 60 * 1000;

/**
 * Cache directory we extract embedded scripts into for spawn-as-child usage.
 * Every installed version nests under a single fixed, reused parent
 * (`tmpdir()/cam-cli-vendor`) rather than getting its own top-level entry,
 * so a machine that upgrades cam-cli repeatedly doesn't accumulate a
 * permanent directory per version. The OS tmpdir does not reliably clear
 * itself across upgrades in practice (measured survivors persisting across
 * reboots); pruning of stale sibling versions below is what actually
 * bounds the cache, not the OS.
 *
 * Override via `CAM_VENDOR_CACHE_DIR` for tests so they don't leak files
 * into the system tmpdir between runs.
 */
function cacheDir(): string {
	const override = process.env['CAM_VENDOR_CACHE_DIR'];
	if (override) return override;
	return join(tmpdir(), VENDOR_CACHE_PARENT_NAME, CAM_VERSION);
}

/**
 * Removes stale sibling version subdirectories under the fixed vendor-cache
 * parent, skipping the current `CAM_VERSION` unconditionally so an in-flight
 * extraction on this machine is never at risk. Limited to entries older than
 * `STALE_VERSION_DIR_AGE_MS` (GOTCHA 8, CAM-510) so a still-running older
 * cam-cli process on this machine keeps its extraction long enough to finish
 * using it. Reads only the fixed parent directory itself, never the shared
 * temp root (GOTCHA 5, CAM-510). Tolerates any stat/removal failure: a
 * concurrent process may already be cleaning up its own directory.
 */
function pruneStaleVersionSiblings(parent: string): void {
	let entries: string[];
	try {
		entries = readdirSync(parent);
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (entry === CAM_VERSION) continue;
		const entryPath = join(parent, entry);
		try {
			const info = statSync(entryPath);
			if (now - info.mtimeMs > STALE_VERSION_DIR_AGE_MS) {
				rmSync(entryPath, { recursive: true, force: true });
			}
		} catch {
			// See doc comment: a concurrent process may already own this entry.
		}
	}
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
	if (!process.env['CAM_VENDOR_CACHE_DIR']) {
		pruneStaleVersionSiblings(join(tmpdir(), VENDOR_CACHE_PARENT_NAME));
	}
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
