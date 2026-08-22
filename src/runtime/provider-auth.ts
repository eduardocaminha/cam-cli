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
 * Whatever identity the validated credential happens to expose -- never what
 * proves it works. A `claude setup-token` credential is limited to inference
 * and commonly reports no email, organization or plan at all (GSHIP-705), so
 * every field here is optional and the object itself is absent when Claude
 * reported none of them. Nothing above this type may promise identity as the
 * confirmation that a dedicated credential was accepted.
 */
export interface ClaudeCredentialIdentity {
	account?: string;
	organization?: string;
	plan?: string;
}

/**
 * The one-time outcome GSHIP-704 requires before persisting a candidate
 * token, narrowed by GSHIP-705 to what a dedicated token can actually
 * demonstrate: `ok` means one real, tool-free inference call succeeded with
 * exactly this token. `identity` rides along only when the isolated status
 * read happened to report some, is never what `ok` rests on, and is never
 * returned again afterward -- like the token itself, which appears in
 * neither field on any outcome.
 */
export interface ClaudeCredentialValidation {
	ok: boolean;
	identity?: ClaudeCredentialIdentity;
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

/**
 * One isolated `claude` invocation carrying exactly the candidate token under
 * test, nothing stored or resolved. `command` is explicit because validation
 * makes two different calls with the same token (GSHIP-705): the inference
 * call that decides the outcome, and the status read that may add identity.
 *
 * Asynchronous, unlike `ProviderCommandRunner` above: one of these calls waits
 * on a model round trip, and Bun's HTTP handlers run on one thread, so
 * blocking on it inside the connect route would stall SSE delivery, run-event
 * ingestion and every other in-flight request for its whole duration -- the
 * same reason git-identity.ts keeps its own `gh` call off request paths.
 */
export type ClaudeTokenRunner = (
	token: string,
	command: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** The one status read both the provider list and the optional identity lookup share. */
const CLAUDE_AUTH_STATUS_COMMAND = ['claude', 'auth', 'status', '--json'];

/**
 * A real inference call waits on the network, and a child that never answers
 * must not hold the connect request open forever. Being killed here reads as
 * a failed validation, which is the fail-closed answer: nothing is persisted.
 */
const CLAUDE_VALIDATION_TIMEOUT_MS = 60_000;

/**
 * The smallest real inference the CLI can be asked for. `claude auth status`
 * alone is not enough (GSHIP-705) -- it reports a login for a token the API
 * then refuses -- so this call, not the status read, is what decides whether a
 * candidate credential is good.
 *
 * Every flag here is load-bearing, and a flag the installed CLI did not accept
 * would exit non-zero, read as a refusal, and reject every valid token -- the
 * same false-refusal class this issue exists to fix. Measured on 2026-08-22
 * against the installed CLI (2.1.233) by running this exact argv:
 *   * with the prompt below, the child answered `{"is_error":false,
 *     "subtype":"success","num_turns":1,"permission_denials":[]}` and
 *     `"result":"ok"`, exit 0 -- so both `--tools ""` (`claude --help`: 'Use
 *     "" to disable all tools') and `--no-session-persistence` are accepted,
 *     not just asserted.
 *   * the same argv asked instead to read `/etc/hosts` still completed with
 *     `is_error:false`, `num_turns:1` and no permission denials, and the child
 *     itself reported having no tools available -- so `--tools ""` really does
 *     empty the built-in surface rather than being silently ignored.
 * `--strict-mcp-config` with an empty `--mcp-config` drops inherited MCP
 * servers, which `--tools` does not govern, and `--disable-slash-commands`
 * plus `--safe-mode` close the skills and customization surfaces -- the same
 * three-surface argument claude-cli-reviewer.ts documents for its own child.
 *
 * The positional prompt deliberately follows a boolean flag: `--tools` and
 * `--mcp-config` are variadic, and a positional argument straight after either
 * would be swallowed as one more of its values.
 */
export const CLAUDE_VALIDATION_COMMAND = [
	'claude',
	'--print',
	'--output-format',
	'json',
	'--safe-mode',
	'--permission-mode',
	'dontAsk',
	'--tools',
	'',
	'--disable-slash-commands',
	'--strict-mcp-config',
	'--mcp-config',
	'{"mcpServers":{}}',
	'--no-session-persistence',
	'Reply with the single word: ok',
];

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

async function defaultClaudeTokenRunner(token: string, command: string[]): ReturnType<ClaudeTokenRunner> {
	try {
		const child = Bun.spawn(command, {
			env: buildClaudeAuthEnv(process.env, token),
			// Nothing to feed a validation child, and an inherited stdin would let
			// one wait on input that never arrives.
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: CLAUDE_VALIDATION_TIMEOUT_MS,
		});
		const [stdout, stderr, exited] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		// A child killed by the timeout above never reported an exit code of its
		// own; it counts as a non-zero exit, which is the fail-closed reading.
		return { exitCode: child.signalCode === null ? exited : 1, stdout, stderr };
	} catch (error) {
		return { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * A dedicated `claude setup-token` credential authenticates as
 * `oauth_token`, not `claude.ai` (GSHIP-705): requiring `claude.ai` reported
 * every dedicated credential as disconnected the moment it was successfully
 * connected, sending the operator back to reconnect a credential that in
 * fact works. `apiKey` stays excluded -- that is a pay-per-token API key,
 * not the subscription this status claims.
 */
function isClaudeSubscriptionAuth(status: Record<string, unknown>): boolean {
	const method = status['authMethod'];
	return status['loggedIn'] === true && (method === 'claude.ai' || method === 'oauth_token');
}

function claudeStatus(run: ProviderCommandRunner, hasCredential: boolean): ProviderStatus {
	const login = hasCredential ? 'dedicated' : 'external';
	const result = run(CLAUDE_AUTH_STATUS_COMMAND);
	if (result.exitCode !== 0) {
		return { id: 'claude', installed: !result.stderr.includes('ENOENT'), subscription: false, label: 'Claude Code', login };
	}
	let status: Record<string, unknown> = {};
	try {
		status = JSON.parse(result.stdout) as Record<string, unknown>;
	} catch {
		return { id: 'claude', installed: true, subscription: false, label: 'Claude Code', login };
	}
	const subscription = isClaudeSubscriptionAuth(status);
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

function parseJsonObject(raw: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}

/**
 * Reads one isolated, tool-free inference call made with the candidate token
 * and answers with the CLI's own refusal, or `null` when the call actually
 * completed. Fail-closed on every uncertainty (GSHIP-705): a non-zero exit,
 * an `is_error` envelope, and output that does not parse as the JSON envelope
 * `--output-format json` promises are all refusals, because none of them
 * demonstrates that this token reached the API. The message is only ever the
 * CLI's own words, truncated -- never the token, which is absent from both
 * streams to begin with.
 */
function claudeInferenceRefusal(result: Awaited<ReturnType<ClaudeTokenRunner>>): string | null {
	const envelope = parseJsonObject(result.stdout);
	if (result.exitCode === 0 && envelope !== null && envelope['is_error'] !== true) return null;
	const stderr = result.stderr.trim();
	if (stderr.length > 0) return stderr.slice(-500);
	const reported = envelope === null ? undefined : stringField(envelope, 'result')?.trim();
	return reported !== undefined && reported.length > 0
		? reported.slice(-500)
		: 'Claude refused this token for inference.';
}

/** A field the CLI actually reported: blank is "not reported", never an empty account shown as one. */
function reportedField(status: Record<string, unknown>, key: string): string | undefined {
	const value = stringField(status, key)?.trim();
	return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Parses one isolated `claude auth status --json` read against an
 * already-validated candidate token into whatever identity it happens to
 * carry. Never a gate: a token from `claude setup-token` is limited to
 * inference and commonly reports no email, organization or plan at all
 * (GSHIP-705), so an absent, failed or identity-less read yields `undefined`
 * -- "not available" -- and the credential stays validated on the strength of
 * the inference call alone. `orgName` is the field the CLI reports today;
 * `organizationName` is accepted alongside it so a build that names it the
 * older way is read rather than silently dropped.
 */
function parseClaudeIdentity(result: Awaited<ReturnType<ClaudeTokenRunner>>): ClaudeCredentialIdentity | undefined {
	if (result.exitCode !== 0) return undefined;
	const status = parseJsonObject(result.stdout);
	if (status === null || status['loggedIn'] !== true) return undefined;
	const account = reportedField(status, 'email');
	const organization = reportedField(status, 'orgName') ?? reportedField(status, 'organizationName');
	const plan = reportedField(status, 'subscriptionType');
	if (account === undefined && organization === undefined && plan === undefined) return undefined;
	return {
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
	 * Decides a candidate token on one isolated, tool-free inference call made
	 * with exactly that token (GSHIP-705) -- the only check that distinguishes
	 * a credential Claude will actually serve from one `claude auth status`
	 * reports as logged in and the API then refuses. Only once that call
	 * succeeds is a second isolated status read made, purely to add identity
	 * when it happens to be available; its failure changes nothing. Never
	 * persists anything -- persistence is the caller's own explicit next step.
	 */
	async validateClaudeCredential(token: string): Promise<ClaudeCredentialValidation> {
		const trimmed = token.trim();
		if (trimmed.length === 0) return { ok: false, message: 'A non-empty token is required.' };
		const refusal = claudeInferenceRefusal(await this.#runClaudeToken(trimmed, CLAUDE_VALIDATION_COMMAND));
		if (refusal !== null) return { ok: false, message: refusal };
		const identity = parseClaudeIdentity(await this.#runClaudeToken(trimmed, CLAUDE_AUTH_STATUS_COMMAND));
		return { ok: true, ...(identity === undefined ? {} : { identity }) };
	}

	startCodexLogin(): Promise<CodexLoginStart> {
		return this.#codex.startChatGptLogin();
	}

	close(): Promise<void> {
		return this.#codex.close();
	}
}
