#!/usr/bin/env bun
// scripts/next-release-version.ts
//
// Deterministic next-release-version selection for the automatic release
// path (GSHIP-665, .github/workflows/release.yml). The repository's existing
// pre-1.0 convention: the next release always increments the MINOR of the
// highest valid `vMAJOR.MINOR.PATCH` tag and resets PATCH to zero. MAJOR
// never moves on its own, and a historical PATCH release (e.g. v0.1.1) never
// changes what the *next* tag looks like -- it is still only a MINOR bump.
// No valid tags at all means this is the first release, v0.1.0.
//
// Usage (invoked by the release workflow):
//   git tag -l 'v*' | bun run scripts/next-release-version.ts
// or with tag names as arguments:
//   bun run scripts/next-release-version.ts v0.1.0 v0.2.0

const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;

type ParsedTag = { major: number; minor: number; patch: number };

function parseTag(tag: string): ParsedTag | null {
	const match = TAG_PATTERN.exec(tag.trim());
	if (match === null) return null;
	return {
		major: Number.parseInt(match[1]!, 10),
		minor: Number.parseInt(match[2]!, 10),
		patch: Number.parseInt(match[3]!, 10),
	};
}

function isHigher(candidate: ParsedTag, current: ParsedTag): boolean {
	if (candidate.major !== current.major) return candidate.major > current.major;
	if (candidate.minor !== current.minor) return candidate.minor > current.minor;
	return candidate.patch > current.patch;
}

/** The next release tag, given every existing tag name in any order, valid or not. */
export function nextReleaseVersion(tags: readonly string[]): string {
	let highest: ParsedTag | null = null;
	for (const tag of tags) {
		const parsed = parseTag(tag);
		if (parsed === null) continue;
		if (highest === null || isHigher(parsed, highest)) highest = parsed;
	}
	if (highest === null) return 'v0.1.0';
	return `v${highest.major}.${highest.minor + 1}.0`;
}

if (import.meta.main) {
	const argTags = process.argv.slice(2);
	const tags = argTags.length > 0
		? argTags
		: (await Bun.stdin.text()).split('\n').filter((line) => line.trim().length > 0);
	process.stdout.write(`${nextReleaseVersion(tags)}\n`);
}
