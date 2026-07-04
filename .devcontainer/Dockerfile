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
        sudo iptables ipset dnsmasq dnsutils curl jq \
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

# Configure git HTTPS credential helper for github.com (US-003, CAM-150).
# The helper script reads $GITHUB_TOKEN at credential-request time (runtime);
# it never writes a credential file to disk (unlike credential.helper=store,
# which would write a host cred file and violate the no-cred-file policy).
# Username is the literal string x-access-token (GitHub HTTPS token convention).
# No SSH key mount is used; git push/fetch authenticates over HTTPS only.
RUN echo '#!/bin/sh' > /usr/local/bin/git-credential-github-token \
    && echo 'echo username=x-access-token' >> /usr/local/bin/git-credential-github-token \
    && echo 'printf "password=%s\n" "${GITHUB_TOKEN}"' >> /usr/local/bin/git-credential-github-token \
    && chmod +x /usr/local/bin/git-credential-github-token \
    && git config --file /home/bun/.gitconfig \
          credential.https://github.com.helper \
          /usr/local/bin/git-credential-github-token \
    && chown bun:bun /home/bun/.gitconfig

# Bake claude onboarding + /workspace trust config into the image (US-001, CAM-179).
# COPY defaults to root:root ownership; the chown -R below re-owns it to HOST_UID:HOST_GID.
# No --chown flag here: a --chown=bun:bun would bind to the pre-usermod uid 1000,
# which is wrong after the re-home. Positioning BEFORE ARG HOST_UID ensures the
# subsequent chown -R /home/bun covers this file.
COPY .devcontainer/claude-config.json /home/bun/.claude.json

# Re-home the bun user to match HOST_UID/HOST_GID (bind-mount write access).
# ARG HOST_UID/HOST_GID default to 1000 (oven/bun base image default).
# GID-collision guard: if HOST_GID already exists (e.g. macOS staff=20), use
# usermod -g to switch bun's primary group to that existing gid directly;
# otherwise claim the gid via groupmod first, then adjust the uid only.
# usermod -g requires the group to already exist (usermod(8) invariant),
# which is exactly why the getent branch is mandatory.
ARG HOST_UID=1000
ARG HOST_GID=1000
RUN if getent group "$HOST_GID" >/dev/null 2>&1; then \
        usermod -u "$HOST_UID" -g "$HOST_GID" bun; \
    else \
        groupmod -g "$HOST_GID" bun && usermod -u "$HOST_UID" bun; \
    fi \
    && mkdir -p /home/bun/.claude \
    && chown -R "$HOST_UID:$HOST_GID" /home/bun

# Switch to non-root user (the oven/bun image ships with a pre-created bun user)
USER bun

WORKDIR /workspace
