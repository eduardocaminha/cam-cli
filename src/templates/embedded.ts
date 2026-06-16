// src/templates/embedded.ts
//
// Runtime API over the codegenned `templatesContents` map. Materializes the
// embedded template tree into a project directory at install time. The
// codegen lives in `scripts/generate-embedded-vendor.ts`.
//
// Why embedded? `bun build --compile` only bundles transitively-imported TS
// modules — arbitrary file dirs (like `templates/`) are NOT included in the
// resulting binary, so reading from `templates/` at runtime works in dev
// (`bun src/...`) but silently fails in the compiled binary. Embedding as
// string constants is the only way to ship templates with a compiled CLI.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { templatesContents } from '../vendor/_generated.ts';

export { templatesContents };

/**
 * Top-level subtrees the templates ship. Used to produce a per-target
 * file count for human-readable output.
 */
const SUBTREES = ['commands', 'agents', 'scripts/cam'] as const;
export type TemplateSubtree = (typeof SUBTREES)[number];

/**
 * Resolve where each template subtree should land in the target project.
 * Mirrors the previous on-disk layout under `cwd`.
 */
function targetPath(cwd: string, relPath: string): string {
	if (relPath.startsWith('commands/')) {
		return join(cwd, '.claude', 'commands', relPath.slice('commands/'.length));
	}
	if (relPath.startsWith('agents/')) {
		return join(cwd, '.claude', 'agents', relPath.slice('agents/'.length));
	}
	if (relPath.startsWith('scripts/cam/')) {
		return join(cwd, 'scripts', 'cam', relPath.slice('scripts/cam/'.length));
	}
	return join(cwd, relPath);
}

/**
 * Merge the cam ignore patterns into the target `.gitignore` instead of
 * overwriting it.
 *
 * `cam init` runs in a project that very likely already has its own
 * `.gitignore`. A blind `writeFileSync` would destroy it (silent data loss),
 * so for the one top-level template file we ship (`.gitignore`) we append only
 * the pattern lines that are not already present. Idempotent: re-running
 * `cam init` does not duplicate them. If the project has no `.gitignore` yet,
 * the template (with its explanatory comments) is written verbatim.
 */
function mergeGitignore(dst: string, templateContents: string): void {
	if (!existsSync(dst)) {
		writeFileSync(dst, templateContents, 'utf8');
		return;
	}
	const existing = readFileSync(dst, 'utf8');
	const have = new Set(existing.split('\n').map((l) => l.trim()));
	// Carry over only real pattern lines (skip blanks and comments); the
	// downstream file keeps its own comments and ordering.
	const missing = templateContents
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l !== '' && !l.startsWith('#') && !have.has(l));
	if (missing.length === 0) return; // already covered: no-op
	const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
	writeFileSync(dst, `${existing}${sep}${missing.join('\n')}\n`, 'utf8');
}

/**
 * Materialize every embedded template into the target project directory.
 * Returns the per-subtree file count so the caller can log progress.
 */
export function materializeTemplates(cwd: string): Record<TemplateSubtree, number> {
	const counts: Record<TemplateSubtree, number> = {
		commands: 0,
		agents: 0,
		'scripts/cam': 0,
	};
	for (const [relPath, contents] of Object.entries(templatesContents)) {
		const dst = targetPath(cwd, relPath);
		mkdirSync(dirname(dst), { recursive: true });
		// `.gitignore` lands at the project root, where the downstream project
		// likely already has one. Merge, never clobber (data-loss regression
		// caught in CAM-55 round-2 review). All other templates live under
		// cam-owned subtrees and are safe to overwrite.
		if (relPath === '.gitignore') {
			mergeGitignore(dst, contents);
		} else {
			writeFileSync(dst, contents, 'utf8');
		}
		for (const subtree of SUBTREES) {
			if (relPath.startsWith(`${subtree}/`)) {
				counts[subtree] += 1;
				break;
			}
		}
	}
	return counts;
}
