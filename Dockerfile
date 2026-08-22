# syntax=docker/dockerfile:1
#
# One image, one process: the Gateship service and the CLIs it invokes as
# children (git, gh, claude, codex). A container recreated from this image
# plus the same volume must return the operator to the same place -- see
# compose.yaml for the volume that carries the durable state this image never
# bakes in.

# --- Builder -----------------------------------------------------------
# Compiles the Gateship binary from this exact build context, embedding the
# built UI bundle. A broken build fails `docker build` itself, so it is
# caught inside this run instead of surfacing later against a binary that
# silently drifted from the repository (the GSHIP-639 / GSHIP-641 failure
# mode).
FROM oven/bun:1.3.14-slim AS builder
WORKDIR /src
COPY . .
# `bun install`'s own `prepare` script runs `build:ui` (package.json), so this
# needs the full source tree already in place, not just the manifests.
RUN bun install --frozen-lockfile
# Embeds the commit this image was built from, the same way
# scripts/build-release.sh does for the native binaries (readBuildSha() in
# src/commands/web.ts, GSHIP-648) -- `.dockerignore` excludes `.git/`, so the
# builder has to supply it: `docker build --build-arg
# GSHIP_BUILD_SHA=$(git rev-parse HEAD) .`. An unset ARG still compiles (it is
# not required), it just leaves that sha unknown; GSHIP_CONTAINER_BUILD is a
# second, unconditional marker so the service can tell that case apart from a
# genuine `bun run`/`bun test` source run and stay silent instead of comparing
# against a boot-time ref read that would belong to the project the container
# manages, not to Gateship's own source (see resolveBootSourceSha).
#
# GSHIP_RELEASE_VERSION is the same version-injection contract
# scripts/build-release.sh uses for the native binaries (GSHIP-665): the
# release workflow passes the exact `v*` tag's MAJOR.MINOR.PATCH here, and
# GSHIP_VERSION (src/version.ts) validates and reports it. Left unset -- every
# non-release build, including this image's own CI verification build -- the
# binary stays an explicit development build (`0.0.0-dev`).
ARG GSHIP_BUILD_SHA=""
ARG GSHIP_RELEASE_VERSION=""
RUN bun build --compile --minify \
	--define "GSHIP_BUILD_SHA=\"${GSHIP_BUILD_SHA}\"" \
	--define "GSHIP_CONTAINER_BUILD=\"1\"" \
	--define "GSHIP_RELEASE_VERSION=\"${GSHIP_RELEASE_VERSION}\"" \
	./index.ts --outfile /out/gateship

# --- Runtime -------------------------------------------------------------
# Same base as the builder so the compiled binary's glibc matches exactly.
# git, the GitHub CLI and both agent CLIs (Claude Code, Codex) are what the
# executor, reviewer and orchestrator invoke as children; nothing else the
# product needs to function is installed here.
FROM oven/bun:1.3.14-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
		ca-certificates \
		curl \
		git \
	&& mkdir -p -m 755 /etc/apt/keyrings \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
		| tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
	&& chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update && apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:${PATH}"
RUN curl -fsSL https://claude.ai/install.sh | bash -s 2.1.238
RUN bun add -g @openai/codex@0.148.0

COPY --from=builder /out/gateship /usr/local/bin/gateship

# Bun.serve must bind a non-loopback interface here: Docker's published-port
# proxy always connects to the container's own network address, never its
# loopback. The browser still only ever presents an Origin of 127.0.0.1 or
# localhost, because compose.yaml keeps the published host port restricted to
# loopback -- see GATESHIP_BIND_HOST in src/commands/web.ts.
#
# GATESHIP_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, GH_CONFIG_DIR and
# GIT_CONFIG_GLOBAL point at stable subpaths of the one global state volume.
# Project-owned SQLite state and managed worktrees remain in <repo>/.gship on
# the projects bind instead. GIT_CONFIG_GLOBAL matters
# as much as the other three: `gh auth login`/`gh auth setup-git` wires the
# git credential helper into the global git config, and git (unlike gh) runs
# in the service's unfiltered environment (github-shipper.ts), so without
# this a recreated container would show `gh` still logged in while `git
# push` could no longer authenticate. CODEX_HOME needs one thing claude and
# gh don't: `codex app-server` hard-fails if that directory does not already
# exist, so the service creates it itself at boot (ensureCodexHome in
# src/runtime/provider-env.ts) rather than relying on this image to have
# pre-seeded it -- a volume kept from before the image gained the Codex CLI
# would otherwise never get it.
ENV GATESHIP_BIND_HOST=0.0.0.0 \
	GATESHIP_HOME=/var/lib/gateship \
	CLAUDE_CONFIG_DIR=/var/lib/gateship/claude \
	CODEX_HOME=/var/lib/gateship/codex \
	GH_CONFIG_DIR=/var/lib/gateship/gh \
	GIT_CONFIG_GLOBAL=/var/lib/gateship/gitconfig

WORKDIR /projects
EXPOSE 7777

ENTRYPOINT ["gateship"]
