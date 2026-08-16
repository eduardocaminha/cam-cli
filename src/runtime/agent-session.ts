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
	emit: (kind: string, payload?: Record<string, unknown>) => void;
	eventPrefix: string;
	/** Persist a provider-assigned id as soon as the stream reveals it. */
	onSessionId?: (sessionId: string) => void;
}

export interface AgentSessionResult {
	summary: string;
	structuredOutput?: unknown;
}

/** Minimal bus implemented by every supported subscription-backed agent. */
export interface AgentSession {
	readonly provider: AgentProviderId;
	run(input: AgentSessionInput): Promise<AgentSessionResult>;
}
