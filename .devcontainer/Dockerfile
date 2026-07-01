# Worker base image: bun + git + node + pinned Claude Code CLI, non-root user.
# Pin the CLI to an exact version (never a floating tag) and disable the
# auto-updater so the container stays reproducible.
# Note: Claude Code CLI rejects --dangerously-skip-permissions when run as root,
# so the final USER directive switches to the non-root bun user.

FROM oven/bun:1.2-slim

# Install git (bun and node are provided by the base image)
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# Install pinned Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code@2.1.197

# Disable the auto-updater so the pinned CLI version is never replaced at runtime
ENV DISABLE_AUTOUPDATER=1

# Switch to non-root user (the oven/bun image ships with a pre-created bun user)
USER bun

WORKDIR /workspace
