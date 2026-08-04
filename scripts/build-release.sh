#!/usr/bin/env bash
# scripts/build-release.sh
#
# Cross-compile all four release targets from a single host and (optionally)
# install the host-native artifact locally. Idempotent: re-running overwrites
# `dist/`.
#
# Usage:
#   ./scripts/build-release.sh                          # builds all 4 dist/gateship-<os>-<arch> artifacts
#   ./scripts/build-release.sh --install                # builds + installs host-native binary to ~/.local/bin/{gateship,gship}
#   ./scripts/build-release.sh --install ~/bin/gateship  # builds + installs to the given directory
#
# Targets (US-003, CAM-460): bun-darwin-arm64, bun-darwin-x64, bun-linux-x64,
# bun-linux-arm64. Only the host-native artifact can actually be executed on
# this machine, so only it is smoke-tested (--version + hermetic `init`); the
# other three are cross-compiled binaries verified by architecture (`file`)
# by the caller, not executed here.
#
# This script only ever runs on a macOS host (codesign is macOS-only and is
# required to re-sign the two darwin artifacts).
#
# Install is additive: it creates `gateship` and `gship` at the destination
# and NEVER removes a pre-existing `cam` binary (the loop self-spawns by
# binary name in several places; removal is a deliberate operator step).
set -euo pipefail

# --- Resolve repo root regardless of cwd -----------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# --- Args ------------------------------------------------------------------
DO_INSTALL=false
INSTALL_DEST=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		-h|--help)
			grep '^#' "$0" | head -24 | sed 's/^#//' >&2
			exit 0
			;;
		--install)
			DO_INSTALL=true
			if [[ $# -gt 1 && "$2" != -* ]]; then
				INSTALL_DEST="$2"
				shift
			fi
			;;
		*)
			echo "unknown arg: $1" >&2
			exit 2
			;;
	esac
	shift
done

# --- Read the version literal from src/version.ts --------------------------
VERSION_LINE="$(grep -E "^export const CAM_VERSION = '[0-9]+\.[0-9]+\.[0-9]+'" src/version.ts || true)"
if [[ -z "${VERSION_LINE}" ]]; then
	echo "ERROR: could not parse CAM_VERSION from src/version.ts" >&2
	exit 1
fi
VERSION="$(echo "${VERSION_LINE}" | grep -oE "[0-9]+\.[0-9]+\.[0-9]+")"
echo "[build-release] gateship v${VERSION}"

# --- Resolve the host-native target (US-003) --------------------------------
# `--target=bun-<os>-<arch>` is the documented Bun target string (the docs
# require the `bun-` prefix; see https://bun.sh/docs/bundler/executables).
UNAME_S="$(uname -s)"
UNAME_M="$(uname -m)"
case "${UNAME_S}" in
	Darwin) HOST_OS="darwin" ;;
	*) echo "ERROR: build-release.sh must run on a macOS host (codesign required); got ${UNAME_S}" >&2; exit 1 ;;
esac
case "${UNAME_M}" in
	arm64) HOST_ARCH="arm64" ;;
	x86_64) HOST_ARCH="x64" ;;
	*) echo "ERROR: unsupported host arch ${UNAME_M}" >&2; exit 1 ;;
esac
HOST_TARGET="bun-${HOST_OS}-${HOST_ARCH}"
HOST_BIN=""

# --- Compile all four targets ------------------------------------------------
mkdir -p dist
TARGETS=(
	"bun-darwin-arm64:gateship-darwin-arm64"
	"bun-darwin-x64:gateship-darwin-x64"
	"bun-linux-x64:gateship-linux-x64"
	"bun-linux-arm64:gateship-linux-arm64"
)
# Artifact names the loop below actually produces, appended after codesign so
# the manifest step (US-001, CAM-495) hashes the FINAL bytes, never a glob.
MANIFEST_NAMES=()

for entry in "${TARGETS[@]}"; do
	BUN_TARGET="${entry%%:*}"
	OUT_NAME="${entry##*:}"
	BIN="dist/${OUT_NAME}"

	echo "[build-release] compiling ${BIN} (--target=${BUN_TARGET})"
	bun build --compile --target="${BUN_TARGET}" --minify ./index.ts --outfile "${BIN}"

	# --- Ad-hoc re-sign darwin artifacts only (US-001) ------------------------
	# bun --compile produces a binary whose codesign signature reads invalid;
	# amfid SIGKILL-kills it when installed in a system directory. Re-sign
	# ad-hoc so the binary runs in any destination path. ELF (linux) binaries
	# are never signed.
	case "${BUN_TARGET}" in
		bun-darwin-*)
			codesign --force --sign - "${BIN}"
			codesign -v "${BIN}" || { echo "[build-release] ERROR: codesign verification failed for ${BIN}" >&2; exit 1; }
			echo "[build-release]   codesign: ad-hoc re-sign ok"
			;;
	esac

	# --- Sanity: size (AC2 of the original US-011 story) ----------------------
	SIZE_BYTES="$(stat -f '%z' "${BIN}")"
	SIZE_MB=$(( SIZE_BYTES / 1024 / 1024 ))
	echo "[build-release]   size: ${SIZE_MB} MB (${SIZE_BYTES} bytes)"
	if (( SIZE_MB > 100 )); then
		echo "ERROR: ${BIN} > 100 MB" >&2
		exit 1
	fi

	MANIFEST_NAMES+=("${OUT_NAME}")

	if [[ "${BUN_TARGET}" == "${HOST_TARGET}" ]]; then
		HOST_BIN="${BIN}"
	fi
done

if [[ -z "${HOST_BIN}" ]]; then
	echo "ERROR: no compiled artifact matches the host target ${HOST_TARGET}" >&2
	exit 1
fi

# --- Manifest: dist/SHA256SUMS.txt (US-001, CAM-495) --------------------------
# Written only now that the loop above has closed: every darwin artifact was
# already re-signed, so this hashes the FINAL on-disk bytes a user downloads,
# never a pre-signature hash. Built from MANIFEST_NAMES (the artifact names
# the loop actually produced), never a bare glob over dist/, which could
# silently absorb a stale artifact left over from an earlier build.
echo "[build-release] writing dist/SHA256SUMS.txt"
(cd dist && shasum -a 256 "${MANIFEST_NAMES[@]}" > SHA256SUMS.txt)
echo "[build-release]   wrote dist/SHA256SUMS.txt (${#MANIFEST_NAMES[@]} entries)"

# --- Sanity: --version (host-native artifact only) ---------------------------
echo "[build-release] verifying --version output (${HOST_BIN})"
EXPECTED="gateship ${VERSION}"
ACTUAL="$("${HOST_BIN}" --version)"
if [[ "${ACTUAL}" != "${EXPECTED}" ]]; then
	echo "ERROR: --version mismatch — expected '${EXPECTED}', got '${ACTUAL}'" >&2
	exit 1
fi
echo "[build-release]   ${ACTUAL}"

# --- Sanity: init runs, soft-checks (host-native artifact only) --------------
# `cam init` validates PATH for claude + runs vendored smokes. On the dev
# machine these pass; on a CI box they may fail (no claude binary). We log and
# conditionally abort on non-zero depending on whether claude is installed:
#   - claude absent from PATH: non-zero is acceptable (machine without claude).
#   - claude present but init still fails: real init crash -- abort the build.
#
# CAM-15: the soft-check MUST be hermetic. `cam init` chains `runSetup`, which
# copies templates over the cwd's versioned files and (without --no-tmux)
# spawns a tmux session + a live claude agent. Running it against REPO_ROOT
# clobbered 10 versioned files and left a cam-setup session twice. We isolate
# it on every axis: a throwaway tmpdir as cwd (file writes land there, not the
# repo), --no-tmux (no tmux/agent), --existing --issue-system none (skip the
# interactive setup wizard so it never blocks), </dev/null (belt-and-braces on
# stdin). The binary is referenced by an absolute path so the
# cd does not break resolution. Canonical rule: lessons.archive.md 2026-06-06
# (no mutating command in a build smoke); the 2026-06-13 entry records this fix.
echo "[build-release] invoking init (soft-check, hermetic, ${HOST_BIN})"
SMOKE_DIR="$(mktemp -d)"
# Clean up the tmpdir on any exit (success OR an earlier abort), so it never leaks.
trap 'rm -rf "${SMOKE_DIR:-}"' EXIT
BIN_ABS="${REPO_ROOT}/${HOST_BIN}"
if (cd "${SMOKE_DIR}" && "${BIN_ABS}" init --no-tmux --existing --issue-system none --merge-mode immediate --plan-approval operator </dev/null); then
	echo "[build-release]   init: ok (hermetic tmpdir, no tmux)"
else
	rc=$?
	# Distinguish claude-absent (acceptable) from a real init crash (fatal).
	# Only tolerate non-zero when claude is genuinely missing from PATH.
	if command -v claude >/dev/null 2>&1; then
		echo "[build-release] ERROR: init exited ${rc} with claude installed -- real init crash, not a missing-claude skip" >&2
		exit "${rc}"
	else
		echo "[build-release]   init: exit ${rc} (claude not in PATH, soft-check skipped)"
	fi
fi

# --- Install (--install) -- host-native artifact, additive -------------------
if [[ "${DO_INSTALL}" == "true" ]]; then
	if [[ -n "${INSTALL_DEST}" ]]; then
		DEST_DIR="$(dirname "${INSTALL_DEST}")"
	else
		DEST_DIR="${HOME}/.local/bin"
	fi
	mkdir -p "${DEST_DIR}"

	echo "[build-release] installing to ${DEST_DIR} (gateship, gship)"
	for NAME in gateship gship; do
		DEST="${DEST_DIR}/${NAME}"
		cp "${HOST_BIN}" "${DEST}"

		xattr -cr "${DEST}"

		codesign --force --sign - "${DEST}"
		codesign -v "${DEST}" || { echo "[build-release] ERROR: codesign verification failed for ${DEST}" >&2; exit 1; }
		echo "[build-release]   codesign: ad-hoc re-sign ok (${DEST})"

		SMOKE_ACTUAL="$("${DEST}" --version)"
		if [[ "${SMOKE_ACTUAL}" != "${EXPECTED}" ]]; then
			echo "[build-release] ERROR: --version mismatch -- expected '${EXPECTED}', got '${SMOKE_ACTUAL}'" >&2
			exit 1
		fi
		echo "[build-release]   install smoke: ${SMOKE_ACTUAL} ok (${DEST})"
	done

	case ":${PATH}:" in
		*":${DEST_DIR}:"*)
			;;
		*)
			echo "[build-release] WARNING: ${DEST_DIR} is not on \$PATH -- add it to use 'gateship'/'gship' directly" >&2
			;;
	esac

	echo "[build-release] installed: ${DEST_DIR}/gateship, ${DEST_DIR}/gship"
fi

echo "[build-release] done"
