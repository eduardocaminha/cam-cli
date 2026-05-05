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

import { mkdirSync, writeFileSync } from 'node:fs';
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
		writeFileSync(dst, contents, 'utf8');
		for (const subtree of SUBTREES) {
			if (relPath.startsWith(`${subtree}/`)) {
				counts[subtree] += 1;
				break;
			}
		}
	}
	return counts;
}
