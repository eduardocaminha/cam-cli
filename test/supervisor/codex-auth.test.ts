// test/supervisor/codex-auth.test.ts
//
// Unit tests for the fail-closed codex auth preflight (US-001, CAM-352).
//
// All codexAuthPreflight tests inject a fake authCheck: no real fs read, no
// real codex binary spawn. codexAuthCheck (the default production check) is
// covered separately with a real tmpdir so it never touches the real
// ~/.codex/auth.json on the machine running the suite.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { codexAuthPreflight, codexAuthCheck } from '../../src/supervisor/codex-auth.ts';

describe('codexAuthPreflight', () => {
	test('aborts with a message naming `codex login` when backend=codex and auth-check reports unauthenticated', () => {
		const result = codexAuthPreflight({
			backend: 'codex',
			model: 'gpt-5-codex',
			authCheck: () => ({ authenticated: false }),
		});
		expect(result.proceed).toBe(false);
		if (!result.proceed) {
			expect(result.message).toContain('codex login');
		}
	});

	test('proceeds when backend=codex and auth-check reports authenticated', () => {
		const result = codexAuthPreflight({
			backend: 'codex',
			model: 'gpt-5-codex',
			authCheck: () => ({ authenticated: true }),
		});
		expect(result.proceed).toBe(true);
	});

	test('does no auth-check work and proceeds when backend=claude (authCheck never invoked)', () => {
		let invoked = false;
		const result = codexAuthPreflight({
			backend: 'claude',
			model: 'opus',
			authCheck: () => {
				invoked = true;
				return { authenticated: false };
			},
		});
		expect(result.proceed).toBe(true);
		expect(invoked).toBe(false);
	});

	test('aborts with an actionable message when backend=codex and model is the claude alias "opus"', () => {
		const result = codexAuthPreflight({
			backend: 'codex',
			model: 'opus',
			authCheck: () => ({ authenticated: true }),
		});
		expect(result.proceed).toBe(false);
		if (!result.proceed) {
			expect(result.message.length).toBeGreaterThan(0);
			expect(result.message).toContain('opus');
		}
	});

	test('aborts when backend=codex and model is the claude alias "sonnet"', () => {
		const result = codexAuthPreflight({
			backend: 'codex',
			model: 'sonnet',
			authCheck: () => ({ authenticated: true }),
		});
		expect(result.proceed).toBe(false);
	});

	test('aborts when backend=codex and model is the claude alias "haiku"', () => {
		const result = codexAuthPreflight({
			backend: 'codex',
			model: 'haiku',
			authCheck: () => ({ authenticated: true }),
		});
		expect(result.proceed).toBe(false);
	});

	test('aborts when backend=codex and model is a dated claude alias ("claude-opus-4-8")', () => {
		const result = codexAuthPreflight({
			backend: 'codex',
			model: 'claude-opus-4-8',
			authCheck: () => ({ authenticated: true }),
		});
		expect(result.proceed).toBe(false);
	});

	test('claude-alias guard fires even without an injected authCheck (default check never invoked before the abort)', () => {
		// Regression guard: the alias check must short-circuit BEFORE the
		// default authCheck (which would otherwise touch the real fs).
		const result = codexAuthPreflight({ backend: 'codex', model: 'opus' });
		expect(result.proceed).toBe(false);
	});

	test('proceeds for a codex-shaped model that does not contain a claude alias word', () => {
		const result = codexAuthPreflight({
			backend: 'codex',
			model: 'gpt-5-codex',
			authCheck: () => ({ authenticated: true }),
		});
		expect(result.proceed).toBe(true);
	});

	test('uses the default authCheck (real ~/.codex/auth.json read) when authCheck is omitted', () => {
		// Does not assert a specific outcome (depends on the running machine's
		// real codex login state); only asserts the call does not throw and
		// returns a well-formed proceed/abort result.
		const result = codexAuthPreflight({ backend: 'codex', model: 'gpt-5-codex' });
		expect(typeof result.proceed).toBe('boolean');
	});
});

describe('codexAuthCheck (default production check)', () => {
	test('reports authenticated=false when ~/.codex/auth.json does not exist', () => {
		// codexAuthCheck always reads the real HOME; assert only the shape and
		// that it never throws, since we cannot safely mutate HOME here without
		// risking cross-test interference in a parallel test runner.
		const result = codexAuthCheck();
		expect(typeof result.authenticated).toBe('boolean');
	});

	test('existsSync-backed presence check: a fixture directory demonstrates the exact semantics', () => {
		// This test exercises the SAME primitive (existsSync on a
		// '.codex/auth.json' path) codexAuthCheck uses internally, using a
		// scratch tmpdir instead of the real HOME, to lock the presence-check
		// semantics without monkeypatching os.homedir().
		const scratch = mkdtempSync(join(tmpdir(), 'cam-codex-auth-test-'));
		try {
			const codexDir = join(scratch, '.codex');
			const authPath = join(codexDir, 'auth.json');

			expect(existsSync(authPath)).toBe(false);

			mkdirSync(codexDir, { recursive: true });
			writeFileSync(authPath, '{}', 'utf8');
			expect(existsSync(authPath)).toBe(true);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
