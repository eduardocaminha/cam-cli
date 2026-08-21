import process from 'node:process';

import type { AgentProviderId } from './agent-session.ts';
import { CodexAppServer, type CodexLoginStart } from './codex-app-server.ts';
import { buildProviderAuthEnv } from './provider-env.ts';

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
	login: 'external' | 'web';
	usage?: ProviderUsage;
}

export interface ProviderAuth {
	list(): Promise<ProviderStatus[]>;
	startCodexLogin(): Promise<CodexLoginStart>;
	close(): Promise<void>;
}

export type ProviderCommandRunner = (
	command: string[],
) => { exitCode: number; stdout: string; stderr: string };

function defaultRunner(command: string[]): ReturnType<ProviderCommandRunner> {
	try {
		const result = Bun.spawnSync(command, {
			env: buildProviderAuthEnv(process.env),
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

function claudeStatus(run: ProviderCommandRunner): ProviderStatus {
	const result = run(['claude', 'auth', 'status', '--json']);
	if (result.exitCode !== 0) {
		return { id: 'claude', installed: !result.stderr.includes('ENOENT'), subscription: false, label: 'Claude Code', login: 'external' };
	}
	let status: Record<string, unknown> = {};
	try {
		status = JSON.parse(result.stdout) as Record<string, unknown>;
	} catch {
		return { id: 'claude', installed: true, subscription: false, label: 'Claude Code', login: 'external' };
	}
	const subscription = status['loggedIn'] === true && status['authMethod'] === 'claude.ai';
	const plan = typeof status['subscriptionType'] === 'string' ? status['subscriptionType'] : undefined;
	return {
		id: 'claude',
		installed: true,
		subscription,
		label: 'Claude Code',
		login: 'external',
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
	codex?: CodexAppServer;
	now?: () => string;
}

export class NativeProviderAuth implements ProviderAuth {
	readonly #run: ProviderCommandRunner;
	readonly #codex: CodexAppServer;
	readonly #now: () => string;

	constructor(options: NativeProviderAuthOptions = {}) {
		this.#run = options.run ?? defaultRunner;
		this.#codex = options.codex ?? new CodexAppServer();
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	async list(): Promise<ProviderStatus[]> {
		const claude = claudeStatus(this.#run);
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

	startCodexLogin(): Promise<CodexLoginStart> {
		return this.#codex.startChatGptLogin();
	}

	close(): Promise<void> {
		return this.#codex.close();
	}
}
