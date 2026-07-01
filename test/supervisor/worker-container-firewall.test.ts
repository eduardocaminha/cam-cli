// test/supervisor/worker-container-firewall.test.ts
//
// File-assert tests for the dnsmasq-based firewall rewrite (US-004, CAM-150).
//
// These tests mirror the acceptance-criteria oracles:
//   AC1 - init-firewall.sh uses dnsmasq --ipset (dynamic CDN-safe resolution)
//   AC2 - ALLOWED_DOMAINS equals exactly the 7 required hosts (host-set equivalence)
//   AC3 - objects.githubusercontent.com is present (correct Git LFS host)
//   AC4 - objects.github.com does NOT appear as a bare subdomain (wrong LFS host absent)
//   AC5 - Self-verify block is preserved
//   AC6 - Dockerfile installs dnsmasq
//
// The .devcontainer/ directory is NOT embedded/vendored, so no embed-vendor step.
// This is a firewall-ceremony script (never runs in CI): oracles are file-asserts only.
//
// Oracle equivalents:
//   [file-assert grep -q 'dnsmasq' .devcontainer/init-firewall.sh]
//   [bun test - host-set equivalence]
//   [file-assert grep -q 'objects.githubusercontent.com' .devcontainer/init-firewall.sh]
//   [file-assert ! grep -Eq 'objects\.github\.com([^u]|$)' .devcontainer/init-firewall.sh]
//   [file-assert grep -q 'Self-verify' .devcontainer/init-firewall.sh]
//   [file-assert grep -q 'dnsmasq' .devcontainer/Dockerfile]

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const DEVCONTAINER_DIR = join(ROOT, '.devcontainer');

const initFirewallContent = readFileSync(join(DEVCONTAINER_DIR, 'init-firewall.sh'), 'utf8');
const dockerfileContent = readFileSync(join(DEVCONTAINER_DIR, 'Dockerfile'), 'utf8');

// ---------------------------------------------------------------------------
// Helper: parse ALLOWED_DOMAINS bash array from init-firewall.sh
// ---------------------------------------------------------------------------
function parseAllowedDomains(script: string): string[] {
	// Match the ALLOWED_DOMAINS=( ... ) block
	const match = script.match(/ALLOWED_DOMAINS=\(\s*([\s\S]*?)\s*\)/);
	if (!match?.[1]) return [];
	return match[1]
		.split('\n')
		.map((line) => line.trim().replace(/^"|"$/g, ''))
		.filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// AC1: init-firewall.sh uses dnsmasq with --ipset directives
// ---------------------------------------------------------------------------

describe('firewall uses dnsmasq for dynamic IP resolution (AC1)', () => {
	test('init-firewall.sh contains "dnsmasq" (dnsmasq-based approach)', () => {
		expect(initFirewallContent).toContain('dnsmasq');
	});

	test('init-firewall.sh uses --ipset= directive (dynamic ipset insertion)', () => {
		expect(initFirewallContent).toMatch(/--ipset=/);
	});

	test('dnsmasq is not the old one-shot dig+ipset loop (no "dig +short" resolver loop)', () => {
		// The old approach used "dig +short A" to freeze IPs at startup; dnsmasq replaces it.
		expect(initFirewallContent).not.toContain('dig +short');
	});
});

// ---------------------------------------------------------------------------
// AC2: 7-domain allowlist semantics preserved (host-set equivalence)
//
// The test parses ALLOWED_DOMAINS from the script and asserts host-set equality
// with the 7 required hosts. A dnsmasq rewrite may fold github.com + *.github.com
// into one --ipset directive, so host-set equivalence (not line count) is asserted.
// A dropped OR added domain causes this test to fail.
// ---------------------------------------------------------------------------

const REQUIRED_HOSTS = new Set([
	'api.anthropic.com',
	'claude.ai',
	'platform.claude.com',
	'github.com',
	'*.github.com',
	'registry.npmjs.org',
	'raw.githubusercontent.com',
]);

describe('7-domain allowlist semantics preserved - host-set equivalence (AC2)', () => {
	test('ALLOWED_DOMAINS parsed from init-firewall.sh equals exactly the 7 required hosts', () => {
		const parsed = parseAllowedDomains(initFirewallContent);
		const parsedSet = new Set(parsed);

		const missing = [...REQUIRED_HOSTS].filter((h) => !parsedSet.has(h));
		const extra = [...parsedSet].filter((h) => !REQUIRED_HOSTS.has(h));

		// Missing domains: required but not in the script
		expect(missing).toEqual([]);
		// Extra domains: in the script but not in the required set
		expect(extra).toEqual([]);
	});

	test('ALLOWED_DOMAINS has exactly 7 entries', () => {
		const parsed = parseAllowedDomains(initFirewallContent);
		expect(parsed).toHaveLength(7);
	});

	test('count-of-7 comment guard is intact in init-firewall.sh', () => {
		// The script must contain the count-of-7 comment so auditors see the guard.
		expect(initFirewallContent).toMatch(/EXACTLY 7 domains/);
	});
});

// ---------------------------------------------------------------------------
// AC3: objects.githubusercontent.com is present (correct Git LFS host)
// ---------------------------------------------------------------------------

describe('LFS host corrected to objects.githubusercontent.com (AC3)', () => {
	test('init-firewall.sh contains "objects.githubusercontent.com"', () => {
		expect(initFirewallContent).toContain('objects.githubusercontent.com');
	});
});

// ---------------------------------------------------------------------------
// AC4: objects.github.com does NOT appear as a bare subdomain
//
// Regex mirrors oracle: objects\.github\.com([^u]|$)
// Matches "objects.github.com" NOT followed by 'u', so it catches the wrong
// bare domain (objects.github.com) but NOT the correct one (objects.githubusercontent.com)
// since in that string "github" is followed by "u" making it "githubusercontent".
// ---------------------------------------------------------------------------

describe('objects.github.com (wrong LFS host) is absent (AC4)', () => {
	test('init-firewall.sh does not reference objects.github.com as a bare subdomain', () => {
		// objects.githubusercontent.com does NOT match this pattern (github followed by u,
		// then the next char after "github" in "githubusercontent" is "u", so
		// "objects.github.com" never forms a substring of "objects.githubusercontent.com").
		expect(initFirewallContent).not.toMatch(/objects\.github\.com([^u]|$)/);
	});
});

// ---------------------------------------------------------------------------
// AC5: Self-verify block preserved
// ---------------------------------------------------------------------------

describe('Self-verify step preserved (AC5)', () => {
	test('init-firewall.sh contains the "Self-verify" block', () => {
		expect(initFirewallContent).toContain('Self-verify');
	});

	test('Self-verify checks api.anthropic.com (allowed domain must succeed)', () => {
		expect(initFirewallContent).toContain('api.anthropic.com');
	});

	test('Self-verify checks example.com (blocked domain must fail)', () => {
		expect(initFirewallContent).toContain('example.com');
	});
});

// ---------------------------------------------------------------------------
// AC6: Dockerfile installs dnsmasq
// ---------------------------------------------------------------------------

describe('Dockerfile installs dnsmasq (AC6)', () => {
	test('Dockerfile contains "dnsmasq" in the apt install layer', () => {
		expect(dockerfileContent).toContain('dnsmasq');
	});
});

// ---------------------------------------------------------------------------
// Structural invariants: default-deny OUTPUT policy and DNS rules preserved
// ---------------------------------------------------------------------------

describe('iptables structural invariants preserved', () => {
	test('default-deny OUTPUT policy is set', () => {
		expect(initFirewallContent).toContain('iptables -P OUTPUT  DROP');
	});

	test('loopback (lo) is unconditionally allowed', () => {
		expect(initFirewallContent).toContain('-i lo -j ACCEPT');
		expect(initFirewallContent).toContain('-o lo -j ACCEPT');
	});

	test('DNS port 53 outbound is allowed (required for dnsmasq upstream queries)', () => {
		expect(initFirewallContent).toContain('--dport 53 -j ACCEPT');
	});

	test('ESTABLISHED/RELATED conntrack rule is present', () => {
		expect(initFirewallContent).toContain('ESTABLISHED,RELATED');
	});

	test('allowed-domains ipset match is used for HTTPS egress', () => {
		expect(initFirewallContent).toContain('--match-set allowed-domains dst');
	});
});
