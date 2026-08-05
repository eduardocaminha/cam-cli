#!/usr/bin/env bash
# scripts/check-gitignore-parity.sh
#
# Derived oracle for .gitignore parity between the cam-cli repo root and
# templates/.gitignore (the file `gship init` ships to a downstream project).
# The probe set is never a hand-written list: it is grepped live out of
# src/, index.ts and scripts/*.ts every run, so the surface it checks tracks
# the source instead of decaying back into a manually-enumerated list.
#
# LIMITATION (read before trusting a green run): this is a set-equality
# comparison of git check-ignore verdicts, one side under the repo's own
# .gitignore and one side under templates/.gitignore materialized in a
# throwaway git repo. It detects DIVERGENCE only: it stays green for a
# runtime artifact that is ignored by NEITHER file, because both sides then
# agree (not-ignored == not-ignored) with nothing to diverge from. The
# complementary check for that blind spot is the coverage sweep (auditing
# that every artifact writer in src/ has a corresponding ignore rule at
# all), not this script.
set -uo pipefail
REPO="${1:?repo root}"; cd "$REPO" || exit 2
BASES=$(grep -rhoE "'(\.?cam-[A-Za-z0-9_.*-]+\.(log|json|jsonl|lock|pid|session)|\.cam-[A-Za-z0-9_-]+)'" src index.ts scripts/*.ts 2>/dev/null | tr -d "'" | sort -u)
PROBES=$(mktemp)
for b in $BASES; do case "$b" in *-) echo ".claude/${b}X" >> "$PROBES";; *) echo ".claude/$b" >> "$PROBES";; esac; done
grep -rhoE "'(scripts/cam/[A-Za-z0-9_-]+\.(json|jsonl|txt)|gate-results\.json)'" src index.ts scripts/*.ts 2>/dev/null | tr -d "'" >> "$PROBES"
sort -u -o "$PROBES" "$PROBES"
PROBE_COUNT=$(wc -l < "$PROBES" | tr -d ' ')
echo "PROBES=$PROBE_COUNT"
if [ "$PROBE_COUNT" -eq 0 ]; then
  echo "FAIL: derivation produced zero probes (degenerate source tree, see header)"
  rm -f "$PROBES"
  exit 2
fi
TMP=$(mktemp -d); git init -q "$TMP"; cp templates/.gitignore "$TMP/.gitignore"
RC=0
while read -r p; do [ -z "$p" ] && continue; git check-ignore -q "$p"; here=$?; (cd "$TMP" && git check-ignore -q "$p"); tpl=$?; if [ "$here" -gt 1 ] || [ "$tpl" -gt 1 ]; then echo "ERROR $p"; RC=2; continue; fi; if [ "$here" -ne "$tpl" ]; then echo "DIVERGE $p (here=$here tpl=$tpl)"; RC=1; fi; done < "$PROBES"
rm -rf "$TMP" "$PROBES"; echo "EXIT=$RC"; exit $RC
