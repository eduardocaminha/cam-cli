#!/usr/bin/env bash
# install.sh — curl-able installer for gateship
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/eduardocaminha/cam-cli/main/install.sh | bash
#
# Detects the caller's os/arch, downloads the matching asset from the latest
# GitHub Release (https://github.com/eduardocaminha/cam-cli/releases/download/<tag>/<asset>),
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
set -euo pipefail

REPO="eduardocaminha/cam-cli"
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
	TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
	if [[ -z "${TAG}" ]]; then
		echo "ERROR: could not resolve the latest release tag from the GitHub API" >&2
		exit 1
	fi
fi
echo "[install] gateship ${TAG} (${ASSET})"

URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"

# --- Download to a private tmpfile -------------------------------------------
TMP_BIN="$(mktemp)"
trap 'rm -f "${TMP_BIN}"' EXIT
echo "[install] downloading ${URL}"
if ! curl -fsSL "${URL}" -o "${TMP_BIN}"; then
	echo "ERROR: download failed — ${URL}" >&2
	exit 1
fi
chmod +x "${TMP_BIN}"

# --- Install: additive, never touches a pre-existing 'cam' binary -----------
mkdir -p "${INSTALL_DIR}"
for NAME in gateship gship; do
	DEST="${INSTALL_DIR}/${NAME}"
	cp "${TMP_BIN}" "${DEST}"
	chmod +x "${DEST}"
	if [[ "${OS}" == "darwin" ]]; then
		# A downloaded binary is quarantined by Gatekeeper even though it is
		# ad-hoc signed; strip the quarantine bit so it can run.
		xattr -d com.apple.quarantine "${DEST}" 2>/dev/null || true
	fi
	echo "[install]   installed ${DEST}"
done

case ":${PATH}:" in
	*":${INSTALL_DIR}:"*) ;;
	*)
		echo "[install] WARNING: ${INSTALL_DIR} is not on \$PATH — add 'export PATH=\"${INSTALL_DIR}:\$PATH\"' to your shell profile" >&2
		;;
esac

echo "[install] done. Run 'gateship --version' to verify."
