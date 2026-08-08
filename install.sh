#!/usr/bin/env bash
# install.sh — curl-able installer for gateship
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/gateship-dev/gateship/main/install.sh | bash
#
# Detects the caller's os/arch, downloads the matching asset from the latest
# GitHub Release (https://github.com/gateship-dev/gateship/releases/download/<tag>/<asset>),
# and installs it under two names, `gateship` and `gship`, into
# $HOME/.local/bin by default (override with GATESHIP_INSTALL_DIR).
#
# Additive only: this script never removes or overwrites a pre-existing `cam`
# binary. Removing an old `cam` is a deliberate operator step (ADR-0055), not
# something an installer does on your behalf.
#
# Every release is currently published `--prerelease` (ADR-0055 — the
# ADR-0054 rename window stays open until a stable Release is cut), so
# GitHub's "latest release" API excludes it. We list releases instead and
# take the newest entry. Pin a specific tag with GATESHIP_VERSION=vX.Y.Z.
#
# macOS note: the published binaries are ad-hoc signed, NOT notarized by
# Apple (no Apple Developer account behind this project). A binary downloaded
# from the internet is quarantined by Gatekeeper regardless of ad-hoc
# signing; this script strips that quarantine bit at install time
# (`xattr -d com.apple.quarantine`). See README.md for the full explanation.
#
# Install-time swap: gship auto-spawns itself under its installed name (the
# sidecar, orch-recycle-watch, and dashboard panes all re-exec the binary at
# INSTALL_DIR/gship), so reinstalling while a `gship run` session is live is
# the common case, not an edge case. Every destination is therefore replaced
# by an atomic rename(2) from a fully-prepared staged temp in the SAME
# directory, never by writing into the destination in place: on macOS,
# overwriting the inode a running process still holds open as its executable
# image poisons that image (SIGKILL, rc=137, at the process's next exec, no
# diagnostic); on Linux, the kernel refuses the in-place write outright with
# ETXTBSY. rename(2) is the only swap that keeps the running process on its
# old inode AND guarantees no reader ever observes a partially written file.
# See ADR-0058 and CONTEXT.md ("staged install temp", "atomic install swap").
set -euo pipefail

REPO="gateship-dev/gateship"
INSTALL_DIR="${GATESHIP_INSTALL_DIR:-${HOME}/.local/bin}"

# --- Detect os/arch, map to one of the four published assets ----------------
UNAME_S="$(uname -s)"
UNAME_M="$(uname -m)"
case "${UNAME_S}" in
	Darwin) OS="darwin" ;;
	Linux) OS="linux" ;;
	*)
		echo "ERROR: unsupported OS '${UNAME_S}' — gateship publishes darwin-arm64, darwin-x64, linux-x64, linux-arm64" >&2
		exit 1
		;;
esac
case "${UNAME_M}" in
	arm64|aarch64) ARCH="arm64" ;;
	x86_64|amd64) ARCH="x64" ;;
	*)
		echo "ERROR: unsupported arch '${UNAME_M}'" >&2
		exit 1
		;;
esac
TARGET="${OS}-${ARCH}"
case "${TARGET}" in
	darwin-arm64|darwin-x64|linux-x64|linux-arm64) ;;
	*)
		echo "ERROR: no published asset for ${TARGET}" >&2
		exit 1
		;;
esac
ASSET="gateship-${TARGET}"

# --- Resolve the release tag -------------------------------------------------
if [[ -n "${GATESHIP_VERSION:-}" ]]; then
	TAG="${GATESHIP_VERSION}"
else
	echo "[install] resolving the latest release tag for ${REPO}..."
	if ! RELEASES_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases")"; then
		echo "ERROR: failed to reach the GitHub API to list releases for ${REPO} (network failure or rate limit)" >&2
		exit 1
	fi
	# The grep may legitimately find no match (no releases published yet); `|| true`
	# stops that from tripping `set -e` before the explicit -z check below can run.
	TAG="$(printf '%s' "${RELEASES_JSON}" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')" || true
	if [[ -z "${TAG}" ]]; then
		echo "ERROR: could not resolve the latest release tag from the GitHub API — no releases found for ${REPO}" >&2
		exit 1
	fi
fi
echo "[install] gateship ${TAG} (${ASSET})"

URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"

# --- Download to a private tmpfile -------------------------------------------
TMP_BIN="$(mktemp)"
STAGED=""
trap 'rm -f "${TMP_BIN}"' EXIT
echo "[install] downloading ${URL}"
if ! curl -fsSL "${URL}" -o "${TMP_BIN}"; then
	echo "ERROR: download failed — ${URL}" >&2
	exit 1
fi
chmod +x "${TMP_BIN}"

# --- Verify: SHA-256 checksum against the release's SHA256SUMS.txt ----------
# Confirms the downloaded artifact matches the checksum GitHub Actions
# published alongside it (release.yml) BEFORE anything is copied into
# INSTALL_DIR, so a corrupted or partially tampered download can never
# become an installed binary.
SUMS_URL="https://github.com/${REPO}/releases/download/${TAG}/SHA256SUMS.txt"
TMP_SUMS="$(mktemp)"
trap 'rm -f "${TMP_BIN}" "${TMP_SUMS}" ${STAGED:+"${STAGED}"}' EXIT
echo "[install] downloading ${SUMS_URL}"
if ! curl -fsSL "${SUMS_URL}" -o "${TMP_SUMS}"; then
	echo "ERROR: download failed — ${SUMS_URL}" >&2
	exit 1
fi

# The manifest may legitimately lack an entry for this asset; `|| true` stops
# a no-match `grep` from tripping `set -e` before the explicit -z check below.
EXPECTED_HASH="$(grep -F "  ${ASSET}" "${TMP_SUMS}" | awk '{print $1}')" || true
if [[ -z "${EXPECTED_HASH}" ]]; then
	echo "ERROR: no checksum entry for ${ASSET} in ${SUMS_URL}" >&2
	exit 1
fi

# Resolve a SHA-256 tool portably: macOS ships shasum and not sha256sum;
# Linux ships sha256sum and often not shasum.
if command -v sha256sum >/dev/null 2>&1; then
	if ! ACTUAL_HASH="$(sha256sum "${TMP_BIN}" | awk '{print $1}')"; then
		echo "ERROR: sha256sum failed to hash the downloaded artifact" >&2
		exit 1
	fi
elif command -v shasum >/dev/null 2>&1; then
	if ! ACTUAL_HASH="$(shasum -a 256 "${TMP_BIN}" | awk '{print $1}')"; then
		echo "ERROR: shasum failed to hash the downloaded artifact" >&2
		exit 1
	fi
else
	echo "ERROR: neither sha256sum nor shasum is available to verify the downloaded artifact" >&2
	exit 1
fi

if [[ "${ACTUAL_HASH}" != "${EXPECTED_HASH}" ]]; then
	echo "ERROR: checksum mismatch for ${ASSET} — expected ${EXPECTED_HASH}, got ${ACTUAL_HASH} (download may be corrupted or tampered)" >&2
	exit 1
fi
echo "[install] checksum verified (${ACTUAL_HASH})"

# --- Install: additive, never touches a pre-existing 'cam' binary -----------
# ADR-0058: swap ${DEST} by atomic rename(2) from a staged temp in the SAME
# directory (never $TMPDIR, whose rename would cross filesystems on typical
# Linux targets where /tmp is tmpfs) so an already-running gship/gateship
# keeps its old inode instead of being poisoned (darwin) or refused (linux
# ETXTBSY). The staged file is fully prepared (content, executable bit,
# quarantine strip) BEFORE the rename, so ${DEST} is never observable
# partially written, non-executable, or quarantined.
mkdir -p "${INSTALL_DIR}"
for NAME in gateship gship; do
	DEST="${INSTALL_DIR}/${NAME}"
	STAGED="$(mktemp "${INSTALL_DIR}/.${NAME}.XXXXXX")"
	cp "${TMP_BIN}" "${STAGED}"
	chmod +x "${STAGED}"
	if [[ "${OS}" == "darwin" ]]; then
		# A downloaded binary is quarantined by Gatekeeper even though it is
		# ad-hoc signed; strip the quarantine bit so it can run.
		xattr -d com.apple.quarantine "${STAGED}" 2>/dev/null || true
	fi
	mv -f "${STAGED}" "${DEST}"
	STAGED=""
	echo "[install]   installed ${DEST}"
done

case ":${PATH}:" in
	*":${INSTALL_DIR}:"*) ;;
	*)
		echo "[install] WARNING: ${INSTALL_DIR} is not on \$PATH — add 'export PATH=\"${INSTALL_DIR}:\$PATH\"' to your shell profile" >&2
		;;
esac

echo "[install] done. Run 'gateship --version' to verify."
