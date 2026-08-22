// src/runtime/git-identity.ts
//
// A fresh container's volume-backed global git config (GIT_CONFIG_GLOBAL) has
// no author identity: `git commit` refuses with "Author identity unknown" the
// moment the executor's own commit paths reach it -- issue-intake.ts's
// publishEntryAttempt and GithubShipper's #ship. The image ships no invented
// placeholder identity either -- an authenticated `gh` already knows who the
// operator is, so this derives `user.name`/`user.email` from that account
// instead, and writes it through `git config --global` so it lands wherever
// GIT_CONFIG_GLOBAL already points (the same volume `gh auth setup-git`
// writes its own credential helper to). A machine where `git commit` would
// already succeed -- every normal host, any repository with its own local
// config, and any environment identifying itself only through
// GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL -- never reaches the `gh` call at all; see
// `canCommitAuthorIdentity` for exactly what that covers and why.
//
// The write is gated on ownership: this only ever runs `git config --global
// user.name/email` when GIT_CONFIG_GLOBAL resolves inside the explicit
// GATESHIP_HOME (the container's case), never against whatever `--global`
// would otherwise mean -- the real person's `~/.gitconfig` when running from
// source. Outside that ownership, a missing identity is reported, not fixed.
//
// Two entry points, deliberately kept apart: `checkGitIdentity` is a cheap,
// read-only display -- one local `git var` read, never `gh`, never a write --
// safe to call on every request. `ensureGitIdentity` is the one that actually
// derives and writes, and it belongs only on a commit path (issue-intake.ts's
// publishEntryAttempt, GithubShipper's #ship), called once right before the
// write it protects. Bun's HTTP handlers run on one thread: a `gh` call
// blocking on its network round trip (or its own five-second timeout) inside
// a GET handler would stall every other request the service is trying to
// answer at the same time, which is exactly what made the snapshot the wrong
// place for it.

import { spawnSync } from 'node:child_process';
import { resolve, sep } from 'node:path';
import process from 'node:process';

import { buildGithubCliEnv } from './child-env.ts';

const GH_QUERY_TIMEOUT_MS = 5_000;

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type IdentityCommandRunner = (args: string[]) => CommandResult;

function defaultRunGit(args: string[]): CommandResult {
	const result = spawnSync('git', args, { encoding: 'utf8', env: process.env });
	return {
		exitCode: result.status ?? 1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

/**
 * Named apart from the `spawnSync` call, same as `defaultShipCommand` in
 * github-shipper.ts: a `gh` this repository already depends on (`gh release
 * create` in .github/workflows/release.yml) is not a new unlisted binary,
 * just a second call site for one already accepted.
 */
const GH_BIN = 'gh';

function defaultRunGh(args: string[]): CommandResult {
	const result = spawnSync(GH_BIN, args, {
		encoding: 'utf8',
		env: buildGithubCliEnv(process.env),
		timeout: GH_QUERY_TIMEOUT_MS,
	});
	return {
		exitCode: result.status ?? 1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

export interface GitIdentityCheckOptions {
	runGit?: IdentityCommandRunner;
	/** Defaults to `process.env`; a test supplies its own map instead of mutating the real process. */
	env?: Record<string, string | undefined>;
}

/** A superset of `GitIdentityCheckOptions`: only `ensureGitIdentity` ever needs a `gh` runner. */
export interface GitIdentityOptions extends GitIdentityCheckOptions {
	runGh?: IdentityCommandRunner;
}

export type GitIdentityCheck =
	| { outcome: 'already-configured' }
	| { outcome: 'missing'; detail: string };

export type GitIdentityResult =
	| GitIdentityCheck
	| { outcome: 'derived'; name: string; email: string };

/**
 * Whether `git commit` in `cwd` would succeed right now, without ever
 * actually committing anything. `git var GIT_AUTHOR_IDENT` is the exact
 * resolution git itself performs at commit time: local and global config
 * first, then the `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` environment variables,
 * then an identity git auto-detects from the OS user and hostname when even
 * those are absent -- with a warning on stderr, but a real, successful
 * commit. `git config user.name`/`user.email` alone -- this repository's own
 * earlier attempt at "effective" -- checks only the first of those three and
 * refuses hosts, fixtures, and CI environments git itself would happily
 * commit on: a real regression measured on an ordinary host with no config
 * at all (`git config user.name` empty, `git var GIT_AUTHOR_IDENT` an
 * auto-detected identity) and reproduced exactly by
 * test/web/idle-state.test.ts's own `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`
 * fixture mechanism (`git config` empty, `git var` the env values). Inside a
 * genuinely identity-less container, `git var GIT_AUTHOR_IDENT` fails with
 * git's own "Author identity unknown", the same case this whole module
 * exists to fix -- so this is strictly a more accurate read, not a looser
 * gate. `cwd`'s own worktrees share this local config by construction (a
 * linked worktree's `.git` file points back at the same repository), so this
 * holds too for a commit that actually lands in one of them.
 */
function canCommitAuthorIdentity(runGit: IdentityCommandRunner, cwd: string): boolean {
	return runGit(['-C', cwd, 'var', 'GIT_AUTHOR_IDENT']).exitCode === 0;
}

/**
 * Whether `git config --global` writes land inside the explicit global
 * Gateship home rather than somewhere Gateship does not own -- concretely,
 * `~/.gitconfig` when running from source, since `--global` always means the
 * real person's config there. The container sets both paths to the one named
 * volume (the Dockerfile), so an unset or unrelated path is not owned.
 */
function ownsGlobalGitConfig(env: Record<string, string | undefined>): boolean {
	const configured = env['GIT_CONFIG_GLOBAL'];
	const gateshipHome = env['GATESHIP_HOME'];
	if (configured === undefined || configured.trim().length === 0
		|| gateshipHome === undefined || gateshipHome.trim().length === 0) return false;
	const home = resolve(gateshipHome) + sep;
	return resolve(configured).startsWith(home);
}

const NOT_OWNED_DETAIL = 'no git author identity is configured; set `git config --global user.name`/`user.email`'
	+ ' yourself -- Gateship only derives and writes one inside the container image, where'
	+ ' GIT_CONFIG_GLOBAL points at its own volume-backed state';

/**
 * `checkGitIdentity`'s own words for "owned, but not configured yet": it
 * never consults `gh` (its options have no `runGh` at all), so it has no way
 * to know whether `gh` is authenticated -- only `ensureGitIdentity`, which
 * actually calls it, can say that. Between a successful `gh auth login` and
 * the operator's first commit -- a window the README's own documented
 * first-boot order (compose up, open the UI, log in, then act) makes
 * routine -- a message claiming `gh` is not authenticated would be telling
 * the operator to redo something they already did.
 */
const WILL_DERIVE_ON_COMMIT_DETAIL = 'no git author identity is configured yet; it will be derived from the'
	+ ' authenticated GitHub CLI account on the next commit';

const GH_NOT_AUTHENTICATED_DETAIL = 'no git author identity is configured and the GitHub CLI is not authenticated'
	+ ' yet; run `gh auth login` (and `gh auth setup-git`) inside the container, or set'
	+ ' `git config --global user.name`/`user.email` directly';

/**
 * A cheap, read-only check: one local `git var` read, and nothing else -- its
 * own options do not even accept a `gh` runner, so calling `gh` is not merely
 * avoided, it is impossible. Safe to call on every request; meant for
 * display, the operator-facing snapshot notice in src/commands/web.ts. Its
 * `missing` detail never claims anything about `gh`'s authentication state,
 * since this never checks it -- only what the read above actually found. The
 * derive-and-write counterpart, meant for the commit path alone, is
 * `ensureGitIdentity` below, which starts from this same check and is the one
 * place that both knows and reports whether `gh` itself is the problem.
 */
export function checkGitIdentity(cwd: string, options: GitIdentityCheckOptions = {}): GitIdentityCheck {
	const runGit = options.runGit ?? defaultRunGit;
	const env = options.env ?? process.env;

	if (canCommitAuthorIdentity(runGit, cwd)) return { outcome: 'already-configured' };

	if (!ownsGlobalGitConfig(env)) return { outcome: 'missing', detail: NOT_OWNED_DETAIL };
	return { outcome: 'missing', detail: WILL_DERIVE_ON_COMMIT_DETAIL };
}

interface GithubAccount {
	id?: unknown;
	login?: unknown;
	name?: unknown;
}

/**
 * `<id>+<login>@users.noreply.github.com` is GitHub's own format for an
 * account's private commit email (what "Keep my email addresses private"
 * generates); using it here needs no extra OAuth scope beyond the default
 * `gh auth login` already has, never exposes a real address, and still
 * attributes the commit to the operator's real account on GitHub's web UI.
 */
function deriveIdentity(account: GithubAccount): { name: string; email: string } | null {
	const login = typeof account.login === 'string' ? account.login : null;
	const id = typeof account.id === 'number' ? account.id : null;
	if (login === null || id === null) return null;
	const displayName = typeof account.name === 'string' && account.name.trim().length > 0
		? account.name.trim()
		: login;
	return { name: displayName, email: `${id}+${login}@users.noreply.github.com` };
}

/**
 * Ensures a git author identity exists for `cwd`, deriving a global one from
 * the authenticated `gh` account when none does. Idempotent and safe to call
 * repeatedly: a host where `git commit` would already succeed -- every normal
 * host, any repository or fixture with its own local config, and any
 * environment identifying itself only through
 * GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL -- short-circuits on `checkGitIdentity`
 * alone and never invokes `gh`; a host where Gateship does not own the global
 * git config (running from source) reports a missing identity the same way,
 * without ever calling `gh` or writing. Belongs on a commit path only -- see
 * the module comment.
 */
export function ensureGitIdentity(cwd: string, options: GitIdentityOptions = {}): GitIdentityResult {
	const runGit = options.runGit ?? defaultRunGit;
	const runGh = options.runGh ?? defaultRunGh;
	const env = options.env ?? process.env;

	const check = checkGitIdentity(cwd, { runGit, env });
	if (check.outcome === 'already-configured') return check;
	if (!ownsGlobalGitConfig(env)) return check;

	const account = runGh(['api', 'user', '--jq', '{id: .id, login: .login, name: .name}']);
	if (account.exitCode !== 0) {
		return { outcome: 'missing', detail: GH_NOT_AUTHENTICATED_DETAIL };
	}

	let parsed: GithubAccount;
	try {
		parsed = JSON.parse(account.stdout) as GithubAccount;
	} catch {
		return {
			outcome: 'missing',
			detail: 'could not read the authenticated GitHub account (unexpected `gh api user` output)',
		};
	}

	const derived = deriveIdentity(parsed);
	if (derived === null) {
		return {
			outcome: 'missing',
			detail: 'the authenticated GitHub account has no login/id to derive a git identity from',
		};
	}

	const setName = runGit(['config', '--global', 'user.name', derived.name]);
	const setEmail = runGit(['config', '--global', 'user.email', derived.email]);
	if (setName.exitCode !== 0 || setEmail.exitCode !== 0) {
		return {
			outcome: 'missing',
			detail: 'derived a git identity from the authenticated GitHub account but could not write it'
				+ ' to the global git config',
		};
	}
	return { outcome: 'derived', name: derived.name, email: derived.email };
}
