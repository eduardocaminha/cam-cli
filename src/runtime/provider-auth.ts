import process from 'node:process';

import type { AgentProviderId } from './agent-session.ts';
import { CodexAppServer, type CodexLoginStart } from './codex-app-server.ts';
import { buildClaudeAuthEnv, buildProviderAuthEnv } from './provider-env.ts';

/**
 * One reported usage window (GSHIP-664): Claude's own `rateLimitType`
 * (`five_hour`, `seven_day`, ...) for Claude, or `primary`/`secondary` for
 * Codex's single- and multi-window plan snapshot. `usedPercent` and
 * `resetsAt` are shown only when the source actually reported them -- never
 * a fabricated zero standing in for "not reported".
 */
export interface ProviderUsageWindow {
	window: string;
	status?: 'allowed' | 'allowed_warning' | 'rejected';
	usedPercent?: number;
	windowMinutes?: number;
	observedAt: string;
	resetsAt?: string;
}

export interface ProviderUsageCredits {
	hasCredits: boolean;
	unlimited: boolean;
	balance?: string;
}

export interface ProviderUsageSpendLimit {
	limit: string;
	used: string;
	remainingPercent: number;
	resetsAt?: string;
}

/**
 * Truthful subscription-usage telemetry (GSHIP-664): Claude's windows are
 * derived from real invocations' own rate-limit events, Codex's from a
 * credential-blind `account/rateLimits/read` call. Absent entirely -- never
 * present with fabricated data -- when nothing was ever observed or the read
 * failed; a failed read must never fail provider authentication itself.
 */
export interface ProviderUsage {
	windows: ProviderUsageWindow[];
	credits?: ProviderUsageCredits;
	spendLimit?: ProviderUsageSpendLimit;
	resetCreditCount?: number;
}

export interface ProviderStatus {
	id: AgentProviderId;
	installed: boolean;
	subscription: boolean;
	label: string;
	plan?: string;
	/**
	 * `'dedicated'` is Claude-only (GSHIP-704): a subscription token issued by
	 * `claude setup-token`, isolated from Claude Desktop's and the terminal's
	 * own OAuth/Keychain login. Reported whenever a dedicated credential was
	 * the one in effect for this status read, whether or not it still
	 * resolves to a live subscription -- the origin, not the outcome.
	 */
	login: 'external' | 'web' | 'dedicated';
	usage?: ProviderUsage;
}

/**
 * The one-time confirmation GSHIP-704 requires before persisting a candidate
 * token: enough for the operator to recognize the account, never returned
 * again afterward and never logged. `organization` is omitted, not `null`,
 * when the CLI's own status response does not carry one.
 */
export interface ClaudeCredentialValidation {
	ok: boolean;
	account?: string;
	organization?: string;
	plan?: string;
	/** Present only when `ok` is `false`: the CLI's own refusal, never the token. */
	message?: string;
}

export interface ProviderAuth {
	list(): Promise<ProviderStatus[]>;
	startCodexLogin(): Promise<CodexLoginStart>;
	/** Validates a candidate dedicated Claude token in isolation; never persists it. */
	validateClaudeCredential(token: string): Promise<ClaudeCredentialValidation>;
	close(): Promise<void>;
}

export type ProviderCommandRunner = (
	command: string[],
) => { exitCode: number; stdout: string; stderr: string };

/** One isolated `claude` invocation carrying exactly the candidate token under test, nothing stored or resolved. */
export type ClaudeTokenRunner = (
	token: string,
) => { exitCode: number; stdout: string; stderr: string };

function defaultRunner(command: string[], claudeToken: string | undefined): ReturnType<ProviderCommandRunner> {
	// Only the `claude` command may ever see the dedicated token; every other
	// provider command (Codex's own `--version` fallback among them) keeps
	// using the shared, credential-blind env untouched by this issue.
	const env = command[0] === 'claude'
		? buildClaudeAuthEnv(process.env, claudeToken)
		: buildProviderAuthEnv(process.env);
	try {
		const result = Bun.spawnSync(command, {
			env,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return {
			exitCode: result.exitCode,
			stdout: new TextDecoder().decode(result.stdout),
			stderr: new TextDecoder().decode(result.stderr),
		};
	} catch (error) {
		return { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
	}
}

function defaultClaudeTokenRunner(token: string): ReturnType<ClaudeTokenRunner> {
	try {
		const result = Bun.spawnSync(['claude', 'auth', 'status', '--json'], {
			env: buildClaudeAuthEnv(process.env, token),
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return {
			exitCode: result.exitCode,
			stdout: new TextDecoder().decode(result.stdout),
			stderr: new TextDecoder().decode(result.stderr),
		};
	} catch (error) {
		return { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
	}
}

function claudeStatus(run: ProviderCommandRunner, hasCredential: boolean): ProviderStatus {
	const login = hasCredential ? 'dedicated' : 'external';
	const result = run(['claude', 'auth', 'status', '--json']);
	if (result.exitCode !== 0) {
		return { id: 'claude', installed: !result.stderr.includes('ENOENT'), subscription: false, label: 'Claude Code', login };
	}
	let status: Record<string, unknown> = {};
	try {
		status = JSON.parse(result.stdout) as Record<string, unknown>;
	} catch {
		return { id: 'claude', installed: true, subscription: false, label: 'Claude Code', login };
	}
	const subscription = status['loggedIn'] === true && status['authMethod'] === 'claude.ai';
	const plan = typeof status['subscriptionType'] === 'string' ? status['subscriptionType'] : undefined;
	return {
		id: 'claude',
		installed: true,
		subscription,
		label: 'Claude Code',
		login,
		...(plan === undefined ? {} : { plan }),
	};
}

/**
 * Parses one isolated `claude auth status --json` read against a candidate
 * token, into exactly the confirmation surface GSHIP-704 allows through:
 * account, organization and plan. Never the token itself -- it was never in
 * this response to begin with.
 */
function parseClaudeValidation(result: ReturnType<ClaudeTokenRunner>): ClaudeCredentialValidation {
	if (result.exitCode !== 0) {
		const detail = result.stderr.trim().slice(-500);
		return { ok: false, message: detail.length > 0 ? detail : 'Claude CLI rejected the token.' };
	}
	let status: Record<string, unknown> = {};
	try {
		status = JSON.parse(result.stdout) as Record<string, unknown>;
	} catch {
		return { ok: false, message: 'Claude CLI returned an unexpected response.' };
	}
	if (status['loggedIn'] !== true || status['authMethod'] !== 'claude.ai') {
		return { ok: false, message: 'This token did not resolve to an active Claude subscription.' };
	}
	const account = typeof status['email'] === 'string' ? status['email'] : undefined;
	const organization = typeof status['organizationName'] === 'string' ? status['organizationName'] : undefined;
	const plan = typeof status['subscriptionType'] === 'string' ? status['subscriptionType'] : undefined;
	return {
		ok: true,
		...(account === undefined ? {} : { account }),
		...(organization === undefined ? {} : { organization }),
		...(plan === undefined ? {} : { plan }),
	};
}

function codexStatusFromAccount(accountValue: unknown): ProviderStatus {
	const response = accountValue !== null && typeof accountValue === 'object'
		? accountValue as Record<string, unknown>
		: {};
	const account = response['account'] !== null && typeof response['account'] === 'object'
		? response['account'] as Record<string, unknown>
		: null;
	const subscription = account?.['type'] === 'chatgpt';
	const plan = typeof account?.['planType'] === 'string' ? account['planType'] : undefined;
	return {
		id: 'codex',
		installed: true,
		subscription,
		label: 'Codex',
		login: 'web',
		...(plan === undefined ? {} : { plan }),
	};
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' ? value : undefined;
}

function isoFromUnixSeconds(value: unknown): string | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
	const date = new Date(value * 1_000);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Codex's `usedPercent` is already 0-100; clamped defensively, the same safety `readClaudeRateLimit` applies. */
function normalizeUsedPercent(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
	return Math.min(100, Math.max(0, value));
}

/**
 * One of `rateLimits.primary`/`.secondary` (GSHIP-664). `usedPercent` is
 * required by the wire schema; its absence means the window itself was not
 * usable data, so the whole window is dropped rather than shown with a
 * missing percentage.
 */
function normalizeCodexWindow(name: string, value: unknown, observedAt: string): ProviderUsageWindow | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const usedPercent = normalizeUsedPercent(record['usedPercent']);
	if (usedPercent === undefined) return null;
	const resetsAt = isoFromUnixSeconds(record['resetsAt']);
	const windowMinutes = numberField(record, 'windowDurationMins');
	return {
		window: name,
		usedPercent,
		observedAt,
		...(windowMinutes === undefined ? {} : { windowMinutes }),
		...(resetsAt === undefined ? {} : { resetsAt }),
	};
}

function normalizeCodexCredits(value: unknown): ProviderUsageCredits | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record['hasCredits'] !== 'boolean' || typeof record['unlimited'] !== 'boolean') return undefined;
	const balance = stringField(record, 'balance');
	return {
		hasCredits: record['hasCredits'],
		unlimited: record['unlimited'],
		...(balance === undefined ? {} : { balance }),
	};
}

function normalizeCodexSpendLimit(value: unknown): ProviderUsageSpendLimit | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const limit = stringField(record, 'limit');
	const used = stringField(record, 'used');
	const remainingPercent = numberField(record, 'remainingPercent');
	if (limit === undefined || used === undefined || remainingPercent === undefined) return undefined;
	const resetsAt = isoFromUnixSeconds(record['resetsAt']);
	return {
		limit,
		used,
		remainingPercent,
		...(resetsAt === undefined ? {} : { resetsAt }),
	};
}

/**
 * Normalizes `account/rateLimits/read`'s response into the fields GSHIP-664
 * allows through: the backward-compatible single-bucket `rateLimits.primary`/
 * `.secondary` windows, `rateLimits.credits`, `rateLimits.individualLimit`
 * and `rateLimitResetCredits.availableCount`. Deliberately drops
 * `rateLimits.limitId`/`limitName`, `rateLimitReachedType` and the
 * per-limit-id `rateLimitsByLimitId` breakdown: those are opaque backend
 * identifiers, not the windows/percentages/reset-times/credit summary this
 * issue asked for. `null`, malformed or empty input normalizes to
 * `undefined` -- "unavailable" -- never a fabricated reading.
 */
function normalizeCodexUsage(raw: unknown, observedAt: string): ProviderUsage | undefined {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const root = raw as Record<string, unknown>;
	const rateLimitsValue = root['rateLimits'];
	const rateLimits = rateLimitsValue !== null && typeof rateLimitsValue === 'object' && !Array.isArray(rateLimitsValue)
		? rateLimitsValue as Record<string, unknown>
		: {};
	const windows = [
		normalizeCodexWindow('primary', rateLimits['primary'], observedAt),
		normalizeCodexWindow('secondary', rateLimits['secondary'], observedAt),
	].filter((window): window is ProviderUsageWindow => window !== null);
	const credits = normalizeCodexCredits(rateLimits['credits']);
	const spendLimit = normalizeCodexSpendLimit(rateLimits['individualLimit']);
	const resetCreditsValue = root['rateLimitResetCredits'];
	const resetCreditCount = resetCreditsValue !== null
		&& typeof resetCreditsValue === 'object'
		&& !Array.isArray(resetCreditsValue)
		? numberField(resetCreditsValue as Record<string, unknown>, 'availableCount')
		: undefined;
	if (windows.length === 0 && credits === undefined && spendLimit === undefined && resetCreditCount === undefined) {
		return undefined;
	}
	return {
		windows,
		...(credits === undefined ? {} : { credits }),
		...(spendLimit === undefined ? {} : { spendLimit }),
		...(resetCreditCount === undefined ? {} : { resetCreditCount }),
	};
}

export interface NativeProviderAuthOptions {
	run?: ProviderCommandRunner;
	/** Seam for the isolated candidate-token check `validateClaudeCredential` runs before any persistence. */
	runClaudeToken?: ClaudeTokenRunner;
	/** The dedicated Claude credential in effect, resolved fresh on every `list()` (GSHIP-704). */
	resolveClaudeCredential?: () => string | undefined;
	codex?: CodexAppServer;
	now?: () => string;
}

export class NativeProviderAuth implements ProviderAuth {
	readonly #run: ProviderCommandRunner;
	readonly #runClaudeToken: ClaudeTokenRunner;
	readonly #resolveClaudeCredential: () => string | undefined;
	readonly #codex: CodexAppServer;
	readonly #now: () => string;

	constructor(options: NativeProviderAuthOptions = {}) {
		this.#resolveClaudeCredential = options.resolveClaudeCredential ?? (() => undefined);
		this.#run = options.run ?? ((command) => defaultRunner(command, this.#resolveClaudeCredential()));
		this.#runClaudeToken = options.runClaudeToken ?? defaultClaudeTokenRunner;
		this.#codex = options.codex ?? new CodexAppServer();
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	async list(): Promise<ProviderStatus[]> {
		const claude = claudeStatus(this.#run, this.#resolveClaudeCredential() !== undefined);
		let codex: ProviderStatus;
		try {
			codex = codexStatusFromAccount(await this.#codex.readAccount());
		} catch {
			const installed = this.#run(['codex', '--version']).exitCode === 0;
			codex = { id: 'codex', installed, subscription: false, label: 'Codex', login: 'web' };
		}
		const usage = await this.#readCodexUsage();
		return [claude, usage === undefined ? codex : { ...codex, usage }];
	}

	/** A failed or malformed usage read never fails provider authentication -- it just leaves `usage` absent. */
	async #readCodexUsage(): Promise<ProviderUsage | undefined> {
		try {
			return normalizeCodexUsage(await this.#codex.readRateLimits(), this.#now());
		} catch {
			return undefined;
		}
	}

	/**
	 * Runs the candidate token through an isolated `claude auth status --json`
	 * read (GSHIP-664's own approach to reading status without exposing
	 * identity, here turned the other way: this one *does* report identity,
	 * because confirming it is the entire point, but still never the token
	 * itself). Never persists anything -- persistence is the caller's own
	 * explicit next step once the operator has confirmed the account.
	 */
	async validateClaudeCredential(token: string): Promise<ClaudeCredentialValidation> {
		const trimmed = token.trim();
		if (trimmed.length === 0) return { ok: false, message: 'A non-empty token is required.' };
		return parseClaudeValidation(this.#runClaudeToken(trimmed));
	}

	startCodexLogin(): Promise<CodexLoginStart> {
		return this.#codex.startChatGptLogin();
	}

	close(): Promise<void> {
		return this.#codex.close();
	}
}
