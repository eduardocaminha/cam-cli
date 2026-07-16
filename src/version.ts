// src/version.ts
//
// Single source of truth for the cam-cli version string. Surfaced via
// `cam --version` and embedded in the compiled binary (US-011).
//
// We keep this as a plain TS constant rather than reading `package.json` at
// runtime because:
//   1. `bun build --compile` disables `package.json` autoload by default
//      (per Bun's docs — autoloadPackageJson defaults to false in compiled
//      executables); reading it at runtime would require an explicit
//      `--compile-autoload-package-json` flag.
//   2. `package.json` already carries its own `version` field (needed for
//      `bun install`/registry metadata). Hard-coding the literal here means
//      this file and `package.json` are two places to bump on a release;
//      `test/version.test.ts` asserts they stay equal so they cannot
//      silently diverge.
//
// Bumping the version: edit CAM_VERSION here, run the build + tag flow in
// `scripts/build-release.sh`, push the tag, then `gh release create`.

export const CAM_VERSION = '0.184.0';
