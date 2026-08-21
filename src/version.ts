// src/version.ts
//
// Single source of truth for the Gateship version string. Surfaced via
// `gship --version` and embedded in the compiled binary.
//
// We keep this as a plain TS constant rather than reading `package.json` at
// runtime because `bun build --compile` disables `package.json` autoload by
// default (per Bun's docs -- autoloadPackageJson defaults to false in
// compiled executables); reading it at runtime would require an explicit
// `--compile-autoload-package-json` flag.
//
// GSHIP-665: there is no manually bumped release literal here anymore.
// `GSHIP_VERSION` is the development sentinel `0.0.0-dev` for every local,
// package and ordinary-CI build -- `package.json`'s own `version` field
// matches it (test/version.test.ts asserts parity, so the two cannot
// silently diverge). Only `scripts/build-release.sh` (native targets) and
// the Dockerfile (container images) inject a real released version, via the
// `GSHIP_RELEASE_VERSION` compile-time define, derived from the exact `v*`
// tag `.github/workflows/release.yml` resolved for that build. `gship
// --version` on a released binary reports that injected value; every other
// build reports `0.0.0-dev`.

declare const GSHIP_RELEASE_VERSION: string | undefined;

const DEV_VERSION = '0.0.0-dev';
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Pure resolver so the validate-or-default logic has direct unit coverage
 * without compiling a binary (test/version.test.ts): a present-but-blank
 * define (an unset build-arg, e.g. the Dockerfile's own default) degrades to
 * the development sentinel same as no define at all, but a present,
 * non-blank, malformed one throws rather than silently mislabeling a release
 * build as a development one.
 */
export function resolveReleaseVersion(rawDefine: string | undefined): string {
	if (rawDefine === undefined) return DEV_VERSION;
	const trimmed = rawDefine.trim();
	if (trimmed.length === 0) return DEV_VERSION;
	if (!RELEASE_VERSION_PATTERN.test(trimmed)) {
		throw new Error(
			`GSHIP_RELEASE_VERSION is not a valid MAJOR.MINOR.PATCH version: ${JSON.stringify(trimmed)}`,
		);
	}
	return trimmed;
}

export const GSHIP_VERSION = resolveReleaseVersion(
	typeof GSHIP_RELEASE_VERSION === 'string' ? GSHIP_RELEASE_VERSION : undefined,
);
