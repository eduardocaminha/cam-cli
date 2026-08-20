export type AgentProviderId = 'claude' | 'codex';

/** One provider-neutral turn in a durable coding-agent session. */
export interface AgentSessionInput {
	sessionId: string;
	resume: boolean;
	cwd: string;
	prompt: string;
	access?: 'read-only' | 'write';
	outputSchema?: Record<string, unknown>;
	signal: AbortSignal;
	/**
	 * `eventClass` declares GSHIP-627's activity/decision split at the emit
	 * call site; omitted means the store defaults it to `decision`.
	 */
	emit: (kind: string, payload?: Record<string, unknown>, eventClass?: 'activity' | 'decision') => void;
	eventPrefix: string;
	/** Persist a provider-assigned id as soon as the stream reveals it. */
	onSessionId?: (sessionId: string) => void;
}

export interface AgentSessionResult {
	summary: string;
	structuredOutput?: unknown;
}

export const PROVIDER_ERROR_KINDS = [
	'auth-required',
	'usage-limit',
	'rate-limited',
	'overloaded',
	'model-refused',
	'transport-unavailable',
	'protocol-invalid',
	'cancelled',
	'unknown',
] as const;

export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/**
 * One provider-neutral failure reported at the subscription CLI boundary.
 * `retryAt` is present only when the provider supplied a machine-readable
 * reset instant; Gateship never guesses subscription balance or reset time.
 */
export class ProviderCallError extends Error {
	readonly provider: AgentProviderId;
	readonly kind: ProviderErrorKind;
	readonly retryAt: string | undefined;

	constructor(
		provider: AgentProviderId,
		kind: ProviderErrorKind,
		message: string,
		options: { retryAt?: string; cause?: unknown } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'ProviderCallError';
		this.provider = provider;
		this.kind = kind;
		this.retryAt = options.retryAt;
	}
}

const PROVIDER_FAILURE_PATTERNS: readonly [ProviderErrorKind, RegExp][] = [
	['auth-required', /\b(?:not logged in|login required|authentication required|unauthori[sz]ed|invalid (?:token|credentials)|please (?:log|sign) in)\b/i],
	['usage-limit', /\b(?:session limit|usage limit|weekly limit|quota exceeded|out of credits|credits? exhausted|spend cap reached)\b/i],
	['rate-limited', /\b(?:rate[ -]?limit(?:ed)?|too many requests|http 429|status 429)\b/i],
	['overloaded', /\b(?:overload(?:ed)?|capacity|http 529|status 529|temporarily unavailable)\b/i],
	['model-refused', /\b(?:unknown|invalid|unsupported) model\b|\bmodel\b.{0,80}\b(?:not found|not available|no access|does not exist)\b/i],
	['transport-unavailable', /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|network is unreachable|could not resolve|connection (?:reset|refused)|socket hang up|transport error|timed? out)\b/i],
];

/** Classify stable provider prose only after structured fields were exhausted. */
export function providerErrorFromMessage(
	provider: AgentProviderId,
	message: string,
	fallback: ProviderErrorKind,
	options: { retryAt?: string; cause?: unknown } = {},
): ProviderCallError {
	const detail = message.trim() || `${provider} provider call failed.`;
	const kind = PROVIDER_FAILURE_PATTERNS.find(([, pattern]) => pattern.test(detail))?.[0]
		?? fallback;
	return new ProviderCallError(provider, kind, detail, options);
}

/** Minimal bus implemented by every supported subscription-backed agent. */
export interface AgentSession {
	readonly provider: AgentProviderId;
	run(input: AgentSessionInput): Promise<AgentSessionResult>;
}
