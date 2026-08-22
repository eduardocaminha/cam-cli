// test/runtime/git-identity.test.ts
//
// A fresh container's volume-backed global git config has no author identity
// until this derives one from the authenticated `gh` account (GSHIP-654).
// Most cases here inject fake command runners and an explicit env map: no
// real `git`/`gh` process is spawned and nothing here ever touches the real
// `~/.gitconfig` of whoever runs this suite, so it stays hermetic regardless
// of the host's own global git config or `gh` login state. The one describe
// block that runs real `git` (no fakes) never writes either -- both cases it
// covers resolve on the read alone -- so it stays exactly as safe.

import process from 'node:process';
import { describe, expect, test } from 'bun:test';

import { checkGitIdentity, ensureGitIdentity, type IdentityCommandRunner } from '../../src/runtime/git-identity.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

const CWD = '/repo';
/** The only shape these paths take when Gateship actually owns them -- the Dockerfile's own values. */
const OWNED_ENV = {
	GATESHIP_HOME: '/var/lib/gateship',
	GIT_CONFIG_GLOBAL: '/var/lib/gateship/gitconfig',
};

function ok(stdout = ''): { exitCode: number; stdout: string; stderr: string } {
	return { exitCode: 0, stdout, stderr: '' };
}

function fail(stderr = 'boom'): { exitCode: number; stdout: string; stderr: string } {
	return { exitCode: 1, stdout: '', stderr };
}

/** Every read here is `-C <cwd> var GIT_AUTHOR_IDENT`; every write is `config --global <key> <value>` -- `--global` tells them apart. */
function isWrite(args: string[]): boolean {
	return args.includes('--global');
}

/** A resolvable identity, however git actually found it -- config, env vars, or its own auto-detected guess. */
function resolvableIdent(): IdentityCommandRunner {
	return (args) => (isWrite(args) ? fail() : ok('Eduardo Caminha <eduardo@example.com> 1700000000 -0300\n'));
}

describe('ensureGitIdentity', () => {
	test('a resolvable author identity short-circuits on one read and never calls gh', () => {
		const calls: string[][] = [];
		const runGit: IdentityCommandRunner = (args) => {
			calls.push(args);
			return resolvableIdent()(args);
		};
		const runGh: IdentityCommandRunner = () => {
			throw new Error('gh must not be called when identity is already resolvable');
		};

		// Deliberately no GIT_CONFIG_GLOBAL: an already-configured identity is
		// reported before ownership is ever considered.
		const result = ensureGitIdentity(CWD, { runGit, runGh, env: {} });

		expect(result).toEqual({ outcome: 'already-configured' });
		expect(calls).toEqual([['-C', CWD, 'var', 'GIT_AUTHOR_IDENT']]);
	});

	test('an identity resolvable only through local config or env vars -- never written with --global -- is still recognized', () => {
		// `git var GIT_AUTHOR_IDENT` is exactly git's own resolution order: local
		// config, then GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL, then an auto-detected
		// guess. This fake stands in for any of the three -- what matters here
		// is that a `git commit` that would already succeed must never fall
		// through to gh or a --global write, regardless of which one it is.
		const runGit = resolvableIdent();
		const runGh: IdentityCommandRunner = () => {
			throw new Error('gh must not be called when identity is already resolvable');
		};

		const result = ensureGitIdentity(CWD, { runGit, runGh, env: {} });

		expect(result).toEqual({ outcome: 'already-configured' });
	});

	describe('outside Gateship-owned global git config (running from source)', () => {
		function writeGuard(): IdentityCommandRunner {
			return (args) => {
				if (isWrite(args)) throw new Error(`must never write: ${args.join(' ')}`);
				return fail();
			};
		}

		test('an unset GIT_CONFIG_GLOBAL never calls gh and never writes', () => {
			const runGh: IdentityCommandRunner = () => {
				throw new Error('gh must not be called outside Gateship-owned global git config');
			};

			const result = ensureGitIdentity(CWD, { runGit: writeGuard(), runGh, env: {} });

			expect(result.outcome).toBe('missing');
			if (result.outcome === 'missing') {
				expect(result.detail).toContain('git config --global');
				expect(result.detail).not.toContain('gh auth login');
			}
		});

		test('a GIT_CONFIG_GLOBAL pointing at the real person\'s config never calls gh and never writes', () => {
			const runGh: IdentityCommandRunner = () => {
				throw new Error('gh must not be called outside Gateship-owned global git config');
			};

			const result = ensureGitIdentity(CWD, {
				runGit: writeGuard(),
				runGh,
				env: { GIT_CONFIG_GLOBAL: '/home/operator/.gitconfig' },
			});

			expect(result.outcome).toBe('missing');
		});

		test('a GIT_CONFIG_GLOBAL outside GATESHIP_HOME never calls gh and never writes', () => {
			const runGh: IdentityCommandRunner = () => {
				throw new Error('gh must not be called outside Gateship-owned global git config');
			};

			const result = ensureGitIdentity(CWD, {
				runGit: writeGuard(),
				runGh,
				env: { GATESHIP_HOME: '/var/lib/gateship', GIT_CONFIG_GLOBAL: '/other/gitconfig' },
			});

			expect(result.outcome).toBe('missing');
		});
	});

	describe('inside Gateship-owned global git config (the container)', () => {
		test('derives name and a noreply email from the authenticated gh account', () => {
			const written: Record<string, string> = {};
			const runGit: IdentityCommandRunner = (args) => {
				if (!isWrite(args)) return fail();
				written[args[args.length - 2]!] = args[args.length - 1]!;
				return ok();
			};
			const runGh: IdentityCommandRunner = (args) => {
				expect(args).toEqual(['api', 'user', '--jq', '{id: .id, login: .login, name: .name}']);
				return ok(JSON.stringify({ id: 12345, login: 'gship-operator', name: 'Operator Name' }));
			};

			const result = ensureGitIdentity(CWD, { runGit, runGh, env: OWNED_ENV });

			expect(result).toEqual({
				outcome: 'derived',
				name: 'Operator Name',
				email: '12345+gship-operator@users.noreply.github.com',
			});
			expect(written).toEqual({
				'user.name': 'Operator Name',
				'user.email': '12345+gship-operator@users.noreply.github.com',
			});
		});

		test('falls back to the account login when the display name is blank', () => {
			const runGit: IdentityCommandRunner = (args) => (isWrite(args) ? ok() : fail());
			const runGh: IdentityCommandRunner = () =>
				ok(JSON.stringify({ id: 1, login: 'gship-operator', name: null }));

			const result = ensureGitIdentity(CWD, { runGit, runGh, env: OWNED_ENV });

			expect(result).toEqual({
				outcome: 'derived',
				name: 'gship-operator',
				email: '1+gship-operator@users.noreply.github.com',
			});
		});

		test('an unauthenticated gh reports missing instead of inventing an identity', () => {
			const runGit: IdentityCommandRunner = () => fail();
			const runGh: IdentityCommandRunner = () => fail('gh: not logged in');

			const result = ensureGitIdentity(CWD, { runGit, runGh, env: OWNED_ENV });

			expect(result.outcome).toBe('missing');
			if (result.outcome === 'missing') {
				expect(result.detail).toContain('gh auth login');
			}
		});

		test('unparseable gh output reports missing', () => {
			const runGit: IdentityCommandRunner = () => fail();
			const runGh: IdentityCommandRunner = () => ok('not json');

			expect(ensureGitIdentity(CWD, { runGit, runGh, env: OWNED_ENV }).outcome).toBe('missing');
		});

		test('an account with no login/id reports missing', () => {
			const runGit: IdentityCommandRunner = () => fail();
			const runGh: IdentityCommandRunner = () => ok(JSON.stringify({ name: 'No Login' }));

			expect(ensureGitIdentity(CWD, { runGit, runGh, env: OWNED_ENV }).outcome).toBe('missing');
		});

		test('a failed write after a successful derive still reports missing', () => {
			const runGit: IdentityCommandRunner = (args) => (isWrite(args) ? fail('disk full') : fail());
			const runGh: IdentityCommandRunner = () =>
				ok(JSON.stringify({ id: 1, login: 'gship-operator', name: 'Name' }));

			const result = ensureGitIdentity(CWD, { runGit, runGh, env: OWNED_ENV });

			expect(result.outcome).toBe('missing');
		});
	});
});

// The cheap, read-only half GSHIP-654's snapshot notice actually calls: one
// local `git var` read, never `gh`, never a write, so a GET handler on Bun's
// single-threaded server can never stall on it (unlike ensureGitIdentity,
// whose `gh` call carries a five-second timeout).
describe('checkGitIdentity', () => {
	test('checkGitIdentity has no runGh option at all -- calling gh is not merely avoided, it is impossible', () => {
		// @ts-expect-error runGh is not part of GitIdentityCheckOptions.
		checkGitIdentity(CWD, { runGh: () => ok() });
	});

	test('a resolvable author identity short-circuits on one read', () => {
		const calls: string[][] = [];
		const runGit: IdentityCommandRunner = (args) => {
			calls.push(args);
			return resolvableIdent()(args);
		};

		const result = checkGitIdentity(CWD, { runGit, env: {} });

		expect(result).toEqual({ outcome: 'already-configured' });
		expect(calls).toEqual([['-C', CWD, 'var', 'GIT_AUTHOR_IDENT']]);
	});

	test('a missing identity is reported without ever writing, whether or not Gateship owns the global config', () => {
		function writeGuard(): IdentityCommandRunner {
			return (args) => {
				if (isWrite(args)) throw new Error(`must never write: ${args.join(' ')}`);
				return fail();
			};
		}

		const notOwned = checkGitIdentity(CWD, { runGit: writeGuard(), env: {} });
		expect(notOwned.outcome).toBe('missing');
		if (notOwned.outcome === 'missing') expect(notOwned.detail).toContain('git config --global');

		const owned = checkGitIdentity(CWD, { runGit: writeGuard(), env: OWNED_ENV });
		expect(owned.outcome).toBe('missing');
		if (owned.outcome === 'missing') expect(owned.detail).toContain('derived');
	});

	// checkGitIdentity's own options have no runGh at all, so it has no way to
	// know gh's authentication state -- only ensureGitIdentity, which actually
	// calls gh, can say that. Between a successful `gh auth login` and the
	// operator's first commit (a window the README's own documented first-boot
	// order makes routine: compose up, open the UI, log in, then act), a
	// message claiming gh is not authenticated would tell the operator to redo
	// what they already did.
	test('the cheap read never claims anything about gh authentication, owned or not', () => {
		function writeGuard(): IdentityCommandRunner {
			return (args) => {
				if (isWrite(args)) throw new Error(`must never write: ${args.join(' ')}`);
				return fail();
			};
		}

		for (const env of [{}, OWNED_ENV]) {
			const result = checkGitIdentity(CWD, { runGit: writeGuard(), env });
			expect(result.outcome).toBe('missing');
			if (result.outcome === 'missing') {
				// The claim this closes: a stale "not authenticated, run gh auth
				// login again" verdict this read has no way to actually know.
				expect(result.detail).not.toContain('gh auth login');
				expect(result.detail.toLowerCase()).not.toContain('not authenticated');
			}
		}
	});

	test('an identity resolvable only through local config or env vars is recognized too, same as ensureGitIdentity', () => {
		const runGit = resolvableIdent();

		expect(checkGitIdentity(CWD, { runGit, env: {} })).toEqual({ outcome: 'already-configured' });
	});
});

/**
 * `defaultRunGit` (no fake) against a real, freshly initialized repository,
 * proving the actual `git var GIT_AUTHOR_IDENT` invocation -- not a stand-in
 * for it -- resolves an identity from GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL alone.
 * This is the exact regression measured before this fix: `git config
 * user.name` reads empty in this same repository (the check the two gates
 * used before this closed), while `git commit` -- and now both gates --
 * would already succeed.
 *
 * GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM are redirected to /dev/null so this
 * is isolated from whatever real config the host running this suite happens
 * to have; GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL are then the only source of a
 * resolvable identity. Nothing here writes: an already-resolvable identity is
 * the first branch in both functions, before ownership or `gh` are ever
 * considered, so mutating `process.env` for this real subprocess carries none
 * of the write-corruption risk a container-only, GIT_CONFIG_GLOBAL-owned
 * scenario would.
 */
describe('a host identifying itself only through GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL (GSHIP-654)', () => {
	test('neither gate blocks it', () => {
		const cwd = createTestTmpdir('gship-git-identity-env-only-');
		Bun.spawnSync(['git', 'init', '-q', '-b', 'main'], { cwd });

		const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL'] as const;
		const previous: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
		for (const key of ENV_KEYS) previous[key] = process.env[key];
		process.env['GIT_CONFIG_GLOBAL'] = '/dev/null';
		process.env['GIT_CONFIG_SYSTEM'] = '/dev/null';
		process.env['GIT_AUTHOR_NAME'] = 'Env Only Author';
		process.env['GIT_AUTHOR_EMAIL'] = 'env-only@example.invalid';
		try {
			// Confirms the premise directly: git config alone would report
			// nothing here, exactly the read the two gates no longer perform.
			// `env: process.env` is explicit and required: Bun.spawnSync without
			// it does not see this test's own live process.env mutations above,
			// same as defaultRunGit inside git-identity.ts relies on.
			const configRead = Bun.spawnSync(['git', '-C', cwd, 'config', 'user.name'], {
				env: process.env,
				stdout: 'pipe',
			});
			expect(new TextDecoder().decode(configRead.stdout).trim()).toBe('');

			expect(checkGitIdentity(cwd)).toEqual({ outcome: 'already-configured' });
			expect(ensureGitIdentity(cwd)).toEqual({ outcome: 'already-configured' });
		} finally {
			for (const key of ENV_KEYS) {
				const value = previous[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
