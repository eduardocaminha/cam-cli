#!/bin/bash
# init-firewall.sh -- default-deny egress firewall for the cam worker devcontainer.
#
# Prerequisites: NET_ADMIN + NET_RAW capabilities (granted via devcontainer.json runArgs).
# This script is idempotent: run it multiple times safely; it flushes its own rules first.
# Do NOT invoke from CI (macos-latest, no Docker, no root). Operator/local ceremony only.
set -euo pipefail

# ---------------------------------------------------------------------------
# Allowlist -- EXACTLY 7 domains; do not add an 8th without updating this comment.
# ---------------------------------------------------------------------------
ALLOWED_DOMAINS=(
  "api.anthropic.com"
  "claude.ai"
  "platform.claude.com"
  "github.com"
  "*.github.com"
  "registry.npmjs.org"
  "raw.githubusercontent.com"
)

echo "==> init-firewall: ${#ALLOWED_DOMAINS[@]} allowed domains"

# ---------------------------------------------------------------------------
# Idempotent reset: flush all chains and destroy any previous ipset.
# ---------------------------------------------------------------------------
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true

# ---------------------------------------------------------------------------
# Build ipset of allowed IPs via DNS resolution.
# ---------------------------------------------------------------------------
ipset create allowed-domains hash:net

for domain in "${ALLOWED_DOMAINS[@]}"; do
  if [[ "$domain" == \** ]]; then
    # Wildcard: resolve well-known subdomains for the base (e.g. *.github.com).
    base="${domain#\*.}"
    for sub in "api.$base" "codeload.$base" "uploads.$base" "objects.$base"; do
      while IFS= read -r ip; do
        [[ -n "$ip" ]] && ipset add allowed-domains "$ip" 2>/dev/null || true
      done < <(dig +short A "$sub" 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+){3}$')
    done
  else
    while IFS= read -r ip; do
      [[ -n "$ip" ]] && ipset add allowed-domains "$ip" 2>/dev/null || true
    done < <(dig +short A "$domain" 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+){3}$')
  fi
done

# ---------------------------------------------------------------------------
# Default-deny policy (DROP everything; allowlist is the only exception).
# ---------------------------------------------------------------------------
iptables -P INPUT   DROP
iptables -P FORWARD DROP
iptables -P OUTPUT  DROP

# ---------------------------------------------------------------------------
# Allow loopback (lo) unconditionally.
# ---------------------------------------------------------------------------
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# ---------------------------------------------------------------------------
# Allow already-established / related inbound connections.
# ---------------------------------------------------------------------------
iptables -A INPUT  -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# ---------------------------------------------------------------------------
# Allow DNS outbound (UDP + TCP port 53) -- required for domain resolution.
# ---------------------------------------------------------------------------
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# ---------------------------------------------------------------------------
# Allow HTTPS (443) and HTTP (80) outbound to allowlisted IPs only.
# ---------------------------------------------------------------------------
iptables -A OUTPUT -m set --match-set allowed-domains dst -p tcp --dport 443 -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed-domains dst -p tcp --dport 80  -j ACCEPT

# ---------------------------------------------------------------------------
# Allow SSH (22) outbound to allowlisted IPs only (git push/fetch over SSH).
# ---------------------------------------------------------------------------
iptables -A OUTPUT -m set --match-set allowed-domains dst -p tcp --dport 22  -j ACCEPT

# ---------------------------------------------------------------------------
# Self-verify: confirm an allowed domain is reachable AND a blocked domain is not.
# ---------------------------------------------------------------------------
echo "==> Self-verify: checking allowed domain (api.anthropic.com)..."
if ! curl --connect-timeout 10 --silent -o /dev/null "https://api.anthropic.com"; then
  echo "ERROR: Self-verify FAILED -- api.anthropic.com is unreachable (allowed domain must be reachable)" >&2
  exit 1
fi
echo "    OK: api.anthropic.com is reachable"

echo "==> Self-verify: checking blocked domain (example.com)..."
if curl --connect-timeout 5 --silent -o /dev/null "https://example.com" 2>/dev/null; then
  echo "ERROR: Self-verify FAILED -- example.com is reachable (blocked domain must be denied)" >&2
  exit 1
fi
echo "    OK: example.com is blocked"

echo "==> init-firewall: default-deny egress active. Allowed: ${ALLOWED_DOMAINS[*]}"
