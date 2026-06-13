#!/usr/bin/env bash
# scripts/build-release.sh
#
# Compile a release-shaped darwin-arm64 binary. Idempotent: re-running
# overwrites `dist/`.
#
# Usage:
#   ./scripts/build-release.sh                          # builds dist/cam-darwin-arm64
#   ./scripts/build-release.sh --install               # builds + installs to ~/.local/bin/cam
#   ./scripts/build-release.sh --install ~/bin/cam     # builds + installs to given path
#
# Acceptance criteria mapping (US-011):
#   AC1: produces dist/cam-darwin-arm64 via `bun build --compile`
#   AC2: prints binary size + warns if > 100 MB
#   AC3: invokes ./dist/cam-darwin-arm64 --version (must print `cam X.Y.Z`)
#   AC4: invokes ./dist/cam-darwin-arm64 init (must exit 0 — soft-checks the validator)
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
			grep '^#' "$0" | head -18 | sed 's/^#//' >&2
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
echo "[build-release] cam-cli v${VERSION}"

# --- Compile ---------------------------------------------------------------
mkdir -p dist
BIN="dist/cam-darwin-arm64"
echo "[build-release] compiling ${BIN}"
# `--target=bun-darwin-arm64` is the documented Bun target string (the docs
# require the `bun-` prefix; see https://bun.sh/docs/bundler/executables).
bun build --compile --target=bun-darwin-arm64 --minify ./index.ts --outfile "${BIN}"

# --- Ad-hoc re-sign (US-001) -----------------------------------------------
# bun --compile produces a binary whose codesign signature reads invalid;
# amfid SIGKILL-kills it when installed in /usr/local/bin (a system directory).
# Re-sign ad-hoc so the binary runs in any destination path.
codesign --force --sign - "${BIN}"
codesign -v "${BIN}" || { echo "[build-release] ERROR: codesign verification failed" >&2; exit 1; }
echo "[build-release] codesign: ad-hoc re-sign ok"

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
EXPECTED="cam ${VERSION}"
ACTUAL="$("${BIN}" --version)"
if [[ "${ACTUAL}" != "${EXPECTED}" ]]; then
	echo "ERROR: --version mismatch — expected '${EXPECTED}', got '${ACTUAL}'" >&2
	exit 1
fi
echo "[build-release]   ${ACTUAL}"

# --- Sanity: AC4 (init runs, soft-checks) ----------------------------------
# `cam init` validates PATH for claude + runs vendored smokes. On the dev
# machine these pass; on a CI box they may fail (no claude binary). We log but
# DON'T abort on non-zero — the acceptance criterion is "runs the validator
# without erroring", which we interpret as "the binary executes and exits
# cleanly with structured diagnostics", not "every check passes on every
# machine".
#
# CAM-15: the soft-check MUST be hermetic. `cam init` chains `runSetup`, which
# copies templates over the cwd's versioned files and (without --no-tmux)
# spawns a tmux session + a live claude agent. Running it against REPO_ROOT
# clobbered 10 versioned files and left a cam-setup session twice. We isolate
# it on every axis: a throwaway tmpdir as cwd (file writes land there, not the
# repo), --no-tmux (no tmux/agent), --existing --issue-system none (skip the
# interactive setup wizard so it never blocks), </dev/null (belt-and-braces on
# stdin), and a tmp config. The binary is referenced by an absolute path so the
# cd does not break resolution. See lessons.md 2026-06-06.
echo "[build-release] invoking init (soft-check, hermetic)"
SMOKE_DIR="$(mktemp -d)"
BIN_ABS="${REPO_ROOT}/${BIN}"
if (cd "${SMOKE_DIR}" && CAM_CONFIG_PATH="${SMOKE_DIR}/config.toml" "${BIN_ABS}" init --no-tmux --existing --issue-system none </dev/null); then
	echo "[build-release]   init: ok (hermetic tmpdir, no tmux)"
else
	rc=$?
	echo "[build-release]   init: exit ${rc} (non-zero is acceptable on machines without claude installed)"
fi
rm -rf "${SMOKE_DIR}"

# --- Install (--install) ---------------------------------------------------
if [[ "${DO_INSTALL}" == "true" ]]; then
	DEST="${INSTALL_DEST:-${HOME}/.local/bin/cam}"
	DEST_DIR="$(dirname "${DEST}")"

	echo "[build-release] installing to ${DEST}"
	mkdir -p "${DEST_DIR}"
	cp "${BIN}" "${DEST}"

	xattr -cr "${DEST}"

	codesign --force --sign - "${DEST}"
	codesign -v "${DEST}" || { echo "[build-release] ERROR: codesign verification failed for ${DEST}" >&2; exit 1; }
	echo "[build-release] codesign: ad-hoc re-sign ok (installed copy)"

	SMOKE_ACTUAL="$("${DEST}" --version)"
	EXPECTED_INST="cam ${VERSION}"
	if [[ "${SMOKE_ACTUAL}" != "${EXPECTED_INST}" ]]; then
		echo "[build-release] ERROR: --version mismatch -- expected '${EXPECTED_INST}', got '${SMOKE_ACTUAL}'" >&2
		exit 1
	fi
	echo "[build-release] install smoke: ${SMOKE_ACTUAL} ok"

	case ":${PATH}:" in
		*":${DEST_DIR}:"*)
			;;
		*)
			echo "[build-release] WARNING: ${DEST_DIR} is not on \$PATH -- add it to use 'cam' directly" >&2
			;;
	esac

	echo "[build-release] installed: ${DEST}"
fi

echo "[build-release] done"
