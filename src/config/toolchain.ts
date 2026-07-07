// src/config/toolchain.ts
//
// Single source of truth for the pinned bun and Node.js toolchain versions.
// Both values live in repo-root files that are ALSO consumed by non-TS
// tooling (setup-bun's bun-version-file input, asdf/mise, Renovate):
//
//   - `.bun-version` — a single line, exact semver, no prefix (e.g. "1.3.13").
//   - `.tool-versions` — asdf format; the line we care about is
//     `nodejs <major>.<minor>.<patch>` (exact semver, no prefix).
//
// Downstream consumers (check-ci-parity US-002, buildDockerBuildArgv US-003,
// the container preflight assert US-006/007) all read through this module
// instead of re-parsing the files themselves, so there is exactly one place
// that knows the file format.
//
// The reader is defensive on every error path (missing file, malformed
// content, wrong shape): it returns `null` rather than throwing, mirroring
// the `readPermissionMode` / `readPhaseModel` convention in this directory.
// This module intentionally does NOT touch the filesystem at import time;
// callers pass an injectable `readFileFn` (or accept the default, which
// reads from `process.cwd()`), keeping it a pure, test-friendly seam.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/** Injectable file-read seam. Defaults to `node:fs`'s `readFileSync`. */
export type ReadFileFn = (path: string) => string;

function defaultReadFile(path: string): string {
	return readFileSync(path, 'utf8');
}

function defaultBunVersionPath(): string {
	return join(process.cwd(), '.bun-version');
}

function defaultToolVersionsPath(): string {
	return join(process.cwd(), '.tool-versions');
}

/**
 * Read the pinned bun version from `.bun-version` at repo root.
 *
 * Returns the trimmed contents when the file exists and matches an exact
 * semver (`X.Y.Z`, no prefix, no range). Returns `null` when the file is
 * missing, empty, or does not match that shape (never throws).
 *
 * @param path        Override the `.bun-version` path (default: repo-root
 *                    resolved from `process.cwd()`). Used by tests to target
 *                    a tmp fixture without touching the real pin file.
 * @param readFileFn  Injectable file reader (default: `node:fs.readFileSync`).
 *                    Used by tests to simulate missing/malformed files
 *                    without writing to disk.
 */
export function readPinnedBunVersion(
	path?: string,
	readFileFn: ReadFileFn = defaultReadFile,
): string | null {
	const target = path ?? defaultBunVersionPath();
	try {
		const raw = readFileFn(target).trim();
		if (/^\d+\.\d+\.\d+$/.test(raw)) {
			return raw;
		}
	} catch {
		// Missing file or fs read error: fall through to null.
	}
	return null;
}

/**
 * Read the pinned Node.js version from the `nodejs <version>` line of
 * `.tool-versions` (asdf format) at repo root.
 *
 * Returns the trimmed exact semver (`X.Y.Z`, no prefix) when the file
 * exists and contains a well-formed `nodejs` line. Returns `null` when the
 * file is missing, empty, has no `nodejs` line, or the version does not
 * match the exact-semver shape (never throws).
 *
 * @param path        Override the `.tool-versions` path (default: repo-root
 *                    resolved from `process.cwd()`). Used by tests to target
 *                    a tmp fixture without touching the real pin file.
 * @param readFileFn  Injectable file reader (default: `node:fs.readFileSync`).
 *                    Used by tests to simulate missing/malformed files
 *                    without writing to disk.
 */
export function readPinnedNodeVersion(
	path?: string,
	readFileFn: ReadFileFn = defaultReadFile,
): string | null {
	const target = path ?? defaultToolVersionsPath();
	try {
		const raw = readFileFn(target);
		for (const line of raw.split('\n')) {
			const trimmed = line.trim();
			const match = /^nodejs\s+(\d+\.\d+\.\d+)$/.exec(trimmed);
			if (match?.[1] !== undefined) {
				return match[1];
			}
		}
	} catch {
		// Missing file or fs read error: fall through to null.
	}
	return null;
}
