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

/**
 * Thrown when a session's own structured protocol reports a clean
 * application-level refusal -- an unknown model or a plan without access to
 * it -- as opposed to a timeout, a killed process or a transport failure. The
 * message is the CLI's own text, which already tells the two apart.
 */
export class ProviderRefusalError extends Error {}

/** Minimal bus implemented by every supported subscription-backed agent. */
export interface AgentSession {
	readonly provider: AgentProviderId;
	run(input: AgentSessionInput): Promise<AgentSessionResult>;
}
