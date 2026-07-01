# Worker base image: bun + git + node + pinned Claude Code CLI, non-root user.
# Pin the CLI to an exact version (never a floating tag) and disable the
# auto-updater so the container stays reproducible.
# Note: Claude Code CLI rejects --dangerously-skip-permissions when run as root,
# so the final USER directive switches to the non-root bun user.

FROM oven/bun:1.2-slim

# Install git, Node.js/npm, and firewall tooling.
# oven/bun:1.2-slim ships only bun; Node.js is not included.
# sudo, iptables, ipset, dnsutils (dig), and curl are required by init-firewall.sh.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git nodejs npm \
        sudo iptables ipset dnsutils curl \
    && rm -rf /var/lib/apt/lists/*

# Grant the bun user passwordless sudo for the firewall init script only.
# postStartCommand in devcontainer.json runs: sudo bash /workspace/.devcontainer/init-firewall.sh
RUN echo "bun ALL=(root) NOPASSWD: /bin/bash /workspace/.devcontainer/init-firewall.sh" \
        > /etc/sudoers.d/bun-firewall \
    && chmod 0440 /etc/sudoers.d/bun-firewall

# Install pinned Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code@2.1.197

# Disable the auto-updater so the pinned CLI version is never replaced at runtime
ENV DISABLE_AUTOUPDATER=1

# Switch to non-root user (the oven/bun image ships with a pre-created bun user)
USER bun

WORKDIR /workspace
