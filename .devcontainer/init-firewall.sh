#!/bin/bash
# init-firewall.sh -- default-deny egress firewall for the cam worker devcontainer.
#
# Prerequisites: NET_ADMIN + NET_RAW capabilities (granted via devcontainer.json runArgs).
# This script is idempotent: run it multiple times safely; it flushes its own rules first.
# Do NOT invoke from CI (macos-latest, no Docker, no root). Operator/local ceremony only.
#
# DNS strategy: dnsmasq with --ipset directives resolves allowlisted domains and
# inserts the returned IPs into the allowed-domains ipset on every DNS answer.
# This survives CDN IP rotation over the lifetime of a long-running container --
# unlike a one-shot dig+ipset pass that would freeze IPs at startup.
#
# Port-53 fail-safe (US-004, CAM-207): a leftover container/process from a
# prior session can leave a stale dnsmasq bound to port 53, hard-wedging the
# next session's firewall init. On a bind collision, this script reaps the
# process ACTUALLY holding port 53 (found via /proc, independent of whatever
# pid -- if any -- is recorded in /var/run/dnsmasq-cam.pid), retries the bind
# once, and fails closed (non-zero exit) if the port is still blocked.
set -euo pipefail

# ---------------------------------------------------------------------------
# Allowlist -- EXACTLY 7 domains; do not add an 8th without updating this comment.
# Each entry below corresponds 1-to-1 with a dnsmasq --ipset directive further down.
# Note: dnsmasq --ipset=/github.com/allowed-domains covers github.com AND all
# *.github.com subdomains, so *.github.com is NOT a separate array entry here.
# ---------------------------------------------------------------------------
ALLOWED_DOMAINS=(
  "api.anthropic.com"
  "claude.ai"
  "platform.claude.com"
  "github.com"
  "registry.npmjs.org"
  "raw.githubusercontent.com"
  "objects.githubusercontent.com"
)

echo "==> init-firewall: ${#ALLOWED_DOMAINS[@]} allowed domains"

# ---------------------------------------------------------------------------
# Idempotent reset: flush all chains, destroy any previous ipset,
# and stop a previous dnsmasq-cam instance if one is running.
# ---------------------------------------------------------------------------
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true
if [[ -f /var/run/dnsmasq-cam.pid ]]; then
  kill "$(cat /var/run/dnsmasq-cam.pid)" 2>/dev/null || true
  rm -f /var/run/dnsmasq-cam.pid
fi

# ---------------------------------------------------------------------------
# Create the ipset (empty at start; dnsmasq populates it on every DNS answer).
# ---------------------------------------------------------------------------
ipset create allowed-domains hash:net

# ---------------------------------------------------------------------------
# Start dnsmasq with --ipset directives for dynamic CDN-rotation-safe resolution.
#
# dnsmasq inserts each resolved IP into the allowed-domains ipset automatically
# as DNS answers arrive, keeping the ipset current across CDN IP changes.
#
# Subdomain semantics: --ipset=/github.com/allowed-domains covers github.com
# AND every *.github.com subdomain (dnsmasq subdomain matching is inclusive),
# so github.com + *.github.com collapse into a single directive.
#
# LFS note: objects.githubusercontent.com is the correct Git LFS object host
# (the legacy bare subdomain of github.com is not a valid LFS host).
# ---------------------------------------------------------------------------
start_dnsmasq() {
  dnsmasq \
    --listen-address=127.0.0.1 \
    --port=53 \
    --no-resolv \
    --no-poll \
    --server=8.8.8.8 \
    --server=8.8.4.4 \
    --ipset=/api.anthropic.com/allowed-domains \
    --ipset=/claude.ai/allowed-domains \
    --ipset=/platform.claude.com/allowed-domains \
    --ipset=/github.com/allowed-domains \
    --ipset=/registry.npmjs.org/allowed-domains \
    --ipset=/raw.githubusercontent.com/allowed-domains \
    --ipset=/objects.githubusercontent.com/allowed-domains \
    --pid-file=/var/run/dnsmasq-cam.pid \
    --log-facility=/dev/null
}

# Find every pid actually bound to local port 53 (tcp or udp), independent of
# whatever pid (if any) is recorded in /var/run/dnsmasq-cam.pid -- a stale or
# foreign process (e.g. a leftover dnsmasq from a container that was never
# torn down) can hold the port without ever having been tracked by our own
# pid file. Pure /proc parsing: no lsof/fuser/ss dependency, none of which
# ship in the slim worker image.
find_port_53_pids() {
  local proto sl local_addr rem_addr st txrx trtm retr uid timeout inode extra
  local fd_path target pid
  local -a inodes=()
  local -a pids=()
  for proto in tcp udp; do
    [[ -r /proc/net/$proto ]] || continue
    while read -r sl local_addr rem_addr st txrx trtm retr uid timeout inode extra; do
      [[ "$local_addr" == *:0035 ]] || continue
      [[ -n "$inode" && "$inode" != "0" ]] && inodes+=("$inode")
    done < <(tail -n +2 "/proc/net/$proto" 2>/dev/null || true)
  done
  [[ ${#inodes[@]} -eq 0 ]] && return 0
  for fd_path in /proc/[0-9]*/fd/*; do
    [[ -e "$fd_path" ]] || continue
    target=$(readlink "$fd_path" 2>/dev/null || true)
    [[ "$target" =~ ^socket:\[([0-9]+)\]$ ]] || continue
    for inode in "${inodes[@]}"; do
      if [[ "${BASH_REMATCH[1]}" == "$inode" ]]; then
        pid="${fd_path#/proc/}"
        pid="${pid%%/fd/*}"
        pids+=("$pid")
      fi
    done
  done
  printf '%s\n' "${pids[@]}" | sort -u
}

if ! start_dnsmasq; then
  echo "==> dnsmasq failed to bind port 53; looking for the process actually holding it..." >&2
  mapfile -t stale_pids < <(find_port_53_pids)
  if [[ ${#stale_pids[@]} -gt 0 ]]; then
    echo "==> reaping stale process(es) holding port 53: ${stale_pids[*]}"
    for pid in "${stale_pids[@]}"; do
      kill -9 "$pid" 2>/dev/null || true
    done
    sleep 1
  else
    echo "==> no process found holding port 53 via /proc (holder may have already exited)"
  fi
  rm -f /var/run/dnsmasq-cam.pid
  if ! start_dnsmasq; then
    echo "ERROR: port 53 is still blocked after reap+retry -- failing closed" >&2
    exit 1
  fi
  echo "==> dnsmasq bound port 53 successfully after reap+retry"
fi

# Point the container resolver at the local dnsmasq instance so every DNS
# lookup flows through dnsmasq and triggers ipset insertion.
echo "nameserver 127.0.0.1" > /etc/resolv.conf

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
# Allow DNS outbound (UDP + TCP port 53) -- required for dnsmasq upstream queries.
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
