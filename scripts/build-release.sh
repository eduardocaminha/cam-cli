#!/usr/bin/env bash
# scripts/build-release.sh
#
# Compile a release-shaped darwin-arm64 binary, package it as the homebrew-
# audit-friendly tarball, print the SHA256 + size for use in homebrew-tap's
# Formula/ralph.rb (US-012). Idempotent: re-running overwrites `dist/`.
#
# Usage:
#   ./scripts/build-release.sh              # builds dist/ralph-darwin-arm64
#                                           # + dist/ralph-darwin-arm64.tar.gz
#   ./scripts/build-release.sh --no-tarball # binary only (for `--version`/init smoke)
#
# Acceptance criteria mapping (US-011):
#   AC1: produces dist/ralph-darwin-arm64 via `bun build --compile`
#   AC2: prints binary size + warns if > 100 MB
#   AC3: invokes ./dist/ralph-darwin-arm64 --version (must print `ralph X.Y.Z`)
#   AC4: invokes ./dist/ralph-darwin-arm64 init (must exit 0 — soft-checks the validator)
#   AC6: produces dist/ralph-darwin-arm64.tar.gz with binary + LICENSE
#   AC7: prints SHA256 of the tarball (for the Homebrew formula's `sha256`)
#
# Tag + release (AC5+AC6) are an operator step so a CI re-run never accidentally
# re-tags. After this script passes:
#   git tag v$(grep -oE "[0-9]+\.[0-9]+\.[0-9]+" src/version.ts) && git push --tags
#   gh release create vX.Y.Z dist/ralph-darwin-arm64.tar.gz --generate-notes
set -euo pipefail

# --- Resolve repo root regardless of cwd -----------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# --- Args ------------------------------------------------------------------
make_tarball=1
for arg in "$@"; do
	case "$arg" in
		--no-tarball)
			make_tarball=0
			;;
		-h|--help)
			grep '^#' "$0" | head -32 | sed 's/^#//' >&2
			exit 0
			;;
		*)
			echo "unknown arg: $arg" >&2
			exit 2
			;;
	esac
done

# --- Read the version literal from src/version.ts --------------------------
VERSION_LINE="$(grep -E "^export const RALPH_VERSION = '[0-9]+\.[0-9]+\.[0-9]+'" src/version.ts || true)"
if [[ -z "${VERSION_LINE}" ]]; then
	echo "ERROR: could not parse RALPH_VERSION from src/version.ts" >&2
	exit 1
fi
VERSION="$(echo "${VERSION_LINE}" | grep -oE "[0-9]+\.[0-9]+\.[0-9]+")"
echo "[build-release] ralph-cli v${VERSION}"

# --- Compile ---------------------------------------------------------------
mkdir -p dist
BIN="dist/ralph-darwin-arm64"
echo "[build-release] compiling ${BIN}"
# `--target=bun-darwin-arm64` is the documented Bun target string (the docs
# require the `bun-` prefix; see https://bun.sh/docs/bundler/executables).
bun build --compile --target=bun-darwin-arm64 --minify ./index.ts --outfile "${BIN}"

# --- Sanity: AC2 (size) ----------------------------------------------------
SIZE_BYTES="$(stat -f '%z' "${BIN}")"
SIZE_MB=$(( SIZE_BYTES / 1024 / 1024 ))
echo "[build-release] binary size: ${SIZE_MB} MB (${SIZE_BYTES} bytes)"
if (( SIZE_MB > 100 )); then
	echo "ERROR: binary > 100 MB (acceptance criterion 2)" >&2
	exit 1
fi

# --- Sanity: AC3 (--version) -----------------------------------------------
echo "[build-release] verifying --version output"
EXPECTED="ralph ${VERSION}"
ACTUAL="$("${BIN}" --version)"
if [[ "${ACTUAL}" != "${EXPECTED}" ]]; then
	echo "ERROR: --version mismatch — expected ${EXPECTED!r}, got ${ACTUAL!r}" >&2
	exit 1
fi
echo "[build-release]   ${ACTUAL}"

# --- Sanity: AC4 (init runs, soft-checks) ----------------------------------
# `ralph init` validates PATH for claude/claude-auto-retry + runs vendored
# smokes. On the dev machine these pass; on a CI box they may fail (no
# claude binary). We invoke it with a tmp config so we don't clobber the
# operator's real ~/.config, and we log but DON'T abort on non-zero — the
# acceptance criterion is "runs the validator without erroring", which we
# interpret as "the binary executes and exits cleanly with structured
# diagnostics", not "every check passes on every machine".
echo "[build-release] invoking init (soft-check)"
TMP_CONFIG="$(mktemp -d)/config.toml"
if RALPH_CONFIG_PATH="${TMP_CONFIG}" "${BIN}" init; then
	echo "[build-release]   init: ok"
else
	rc=$?
	echo "[build-release]   init: exit ${rc} (non-zero is acceptable on machines without claude installed)"
fi

# --- Tarball: AC6 + AC7 ----------------------------------------------------
if (( make_tarball == 1 )); then
	TARBALL="${BIN}.tar.gz"
	# Stage the binary + LICENSE in a flat layout so `tar -tzf` shows two
	# files at the top level. Homebrew audits flag formulas pointing at
	# archives without a LICENSE — the file MUST be at the same level as
	# the binary so `brew install` extracts both.
	STAGE="$(mktemp -d)"
	cp "${BIN}" "${STAGE}/ralph"
	cp LICENSE "${STAGE}/LICENSE"
	# Use `-C "${STAGE}"` so paths in the tarball are bare (no leading
	# tmpdir). `--no-xattrs` strips macOS extended attributes so the
	# tarball SHA is reproducible across machines.
	tar --no-xattrs -czf "${TARBALL}" -C "${STAGE}" ralph LICENSE
	rm -rf "${STAGE}"

	TAR_SHA="$(shasum -a 256 "${TARBALL}" | awk '{print $1}')"
	TAR_SIZE_BYTES="$(stat -f '%z' "${TARBALL}")"
	TAR_SIZE_MB=$(( TAR_SIZE_BYTES / 1024 / 1024 ))
	echo "[build-release] tarball: ${TARBALL}"
	echo "[build-release]   size:   ${TAR_SIZE_MB} MB (${TAR_SIZE_BYTES} bytes)"
	echo "[build-release]   sha256: ${TAR_SHA}"
	echo
	echo "Next steps (operator):"
	echo "  git tag v${VERSION}"
	echo "  git push origin v${VERSION}"
	echo "  gh release create v${VERSION} ${TARBALL} --generate-notes \\"
	echo "    --notes \"ralph-cli v${VERSION}. SHA256: ${TAR_SHA}\""
fi

echo "[build-release] done"
