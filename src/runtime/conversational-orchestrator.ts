import { randomUUID } from 'node:crypto';

import type {
	AgentProviderId,
	AgentSession,
} from './agent-session.ts';
import type {
	OrchestratorMessage,
	OrchestratorMessageRole,
} from './run-store.ts';

export type OrchestratorCommand =
	| { type: 'none' }
	| { type: 'create_issue'; title: string; scope: string; verificationCommand: string }
	| {
		type: 'create_and_start_issue';
		title: string;
		scope: string;
		verificationCommand: string;
	}
	| { type: 'specify_issue'; issueId: string; scope: string; verificationCommand: string }
	| { type: 'abandon_issue'; issueId: string; reason: string }
	| { type: 'start_run'; issueId: string }
	| { type: 'resume_run'; runId: string; guidance?: string }
	| { type: 'cancel_run'; runId: string }
	| { type: 'ship_run'; runId: string };

export interface OrchestratorPersistence {
	getSelectedProvider(): AgentProviderId;
	getOrchestratorSession(providerId: AgentProviderId): string | null;
	setOrchestratorSession(providerId: AgentProviderId, sessionId: string): void;
	appendOrchestratorMessage(
		providerId: AgentProviderId,
		role: OrchestratorMessageRole,
		text: string,
	): OrchestratorMessage;
	listOrchestratorMessages(limit?: number): OrchestratorMessage[];
}

export interface ConversationalOrchestratorOptions {
	cwd: string;
	persistence: OrchestratorPersistence;
	sessions: Readonly<Record<AgentProviderId, AgentSession>>;
	context: () => unknown;
	execute: (command: OrchestratorCommand) => string | Promise<string>;
	newSessionId?: () => string;
}

export interface OrchestratorTurnResult {
	assistant: OrchestratorMessage;
	command: OrchestratorCommand;
	commandResult: OrchestratorMessage | null;
}

export class OrchestratorBusyError extends Error {
	constructor() {
		super('The orchestrator is already answering another message.');
		this.name = 'OrchestratorBusyError';
	}
}

export const ORCHESTRATOR_RESULT_SCHEMA = {
	type: 'object',
	properties: {
		message: { type: 'string', minLength: 1 },
		command: {
			type: 'object',
			properties: {
				type: {
					type: 'string',
					enum: [
						'none',
						'create_issue',
						'create_and_start_issue',
						'specify_issue',
						'abandon_issue',
						'start_run',
						'resume_run',
						'cancel_run',
						'ship_run',
					],
				},
				title: { type: 'string' },
				scope: { type: 'string' },
				verificationCommand: { type: 'string' },
				reason: { type: 'string' },
				issueId: { type: 'string' },
				runId: { type: 'string' },
				guidance: { type: 'string' },
			},
			required: ['type'],
			additionalProperties: false,
		},
	},
	required: ['message', 'command'],
	additionalProperties: false,
} as const;

function recordOf(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function requiredText(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new Error(`orchestrator command requires ${key}`);
	}
	return value.trim();
}

export function parseOrchestratorResponse(value: unknown): {
	message: string;
	command: OrchestratorCommand;
} {
	const response = recordOf(value);
	const command = recordOf(response?.['command']);
	const message = response?.['message'];
	const type = command?.['type'];
	if (
		response === null
		|| command === null
		|| typeof message !== 'string'
		|| message.trim().length === 0
		|| typeof type !== 'string'
	) {
		throw new Error('orchestrator returned an invalid structured response');
	}

	let parsed: OrchestratorCommand;
	switch (type) {
		case 'none':
			parsed = { type };
			break;
		case 'create_issue':
			parsed = {
				type,
				title: requiredText(command, 'title'),
				scope: requiredText(command, 'scope'),
				verificationCommand: requiredText(command, 'verificationCommand'),
			};
			break;
		case 'create_and_start_issue':
			parsed = {
				type,
				title: requiredText(command, 'title'),
				scope: requiredText(command, 'scope'),
				verificationCommand: requiredText(command, 'verificationCommand'),
			};
			break;
		case 'specify_issue':
			parsed = {
				type,
				issueId: requiredText(command, 'issueId'),
				scope: requiredText(command, 'scope'),
				verificationCommand: requiredText(command, 'verificationCommand'),
			};
			break;
		case 'abandon_issue':
			parsed = {
				type,
				issueId: requiredText(command, 'issueId'),
				reason: requiredText(command, 'reason'),
			};
			break;
		case 'start_run':
			parsed = { type, issueId: requiredText(command, 'issueId') };
			break;
		case 'resume_run': {
			const guidance = typeof command['guidance'] === 'string'
				? command['guidance'].trim()
				: '';
			parsed = {
				type,
				runId: requiredText(command, 'runId'),
				...(guidance.length === 0 ? {} : { guidance }),
			};
			break;
		}
		case 'cancel_run':
		case 'ship_run':
			parsed = { type, runId: requiredText(command, 'runId') };
			break;
		default:
			throw new Error(`orchestrator returned unknown command: ${type}`);
	}
	return { message: message.trim(), command: parsed };
}

function buildTranscript(messages: readonly OrchestratorMessage[]): string {
	if (messages.length === 0) return '(empty)';
	return messages
		.map((message) => `[${message.role} via ${message.providerId}] ${message.text}`)
		.join('\n');
}

export function buildOrchestratorPrompt(
	context: unknown,
	messages: readonly OrchestratorMessage[],
): string {
	return [
		'You are the Gateship conversational orchestrator, the primary interface for its operator.',
		'Answer in the operator\'s language. You may inspect this repository using read-only tools.',
		'Never edit files, run mutating commands, or mutate Gateship runtime state yourself.',
		'The deterministic Gateship service may execute at most one typed command from your response.',
		'Use command type none for explanations, investigation, status, or whenever an operator decision is still needed.',
		'Do not create planner/auditor loops. Make a concrete recommendation and keep lifecycle policy small.',
		'Only request create_issue or specify_issue when title/scope/verification are concrete.',
		'Only choose create_and_start_issue when the operator asks to implement the work now and the snapshot has no active run; create_issue remains the command to only register work.',
		'Use abandon_issue to close an open issue without shipping it; it requires a concrete reason.',
		'Only use run commands with identifiers visible in the snapshot or transcript.',
		'A run in state done was already shipped and its branch is already merged: never request ship_run for it and never report it as a pending ship.',
		'',
		'Current deterministic snapshot:',
		JSON.stringify(context, null, 2),
		'',
		'Durable cross-session transcript (the final operator entry is the current request):',
		buildTranscript(messages),
		'',
		'Return the required structured response. Put operator-facing prose in message.',
	].join('\n');
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read-only agent conversation; only its one typed result reaches service commands. */
export class ConversationalOrchestrator {
	readonly #options: ConversationalOrchestratorOptions;
	readonly #newSessionId: () => string;
	#active: { controller: AbortController; promise: Promise<OrchestratorTurnResult> } | null = null;

	constructor(options: ConversationalOrchestratorOptions) {
		this.#options = options;
		this.#newSessionId = options.newSessionId ?? randomUUID;
	}

	listMessages(limit?: number): OrchestratorMessage[] {
		return this.#options.persistence.listOrchestratorMessages(limit);
	}

	async turn(text: string): Promise<OrchestratorTurnResult> {
		if (this.#active !== null) throw new OrchestratorBusyError();
		const normalized = text.trim();
		if (normalized.length === 0) throw new Error('operator message is required');
		const controller = new AbortController();
		const promise = this.#runTurn(normalized, controller.signal);
		this.#active = { controller, promise };
		try {
			return await promise;
		} finally {
			if (this.#active?.promise === promise) this.#active = null;
		}
	}

	async stop(): Promise<void> {
		const active = this.#active;
		if (active === null) return;
		active.controller.abort();
		await Promise.allSettled([active.promise]);
	}

	async #runTurn(text: string, signal: AbortSignal): Promise<OrchestratorTurnResult> {
		const persistence = this.#options.persistence;
		const providerId = persistence.getSelectedProvider();
		persistence.appendOrchestratorMessage(providerId, 'operator', text);
		const existingSessionId = persistence.getOrchestratorSession(providerId);
		let sessionId = existingSessionId ?? this.#newSessionId();
		const messages = persistence.listOrchestratorMessages(40);
		const result = await this.#options.sessions[providerId].run({
			sessionId,
			resume: existingSessionId !== null,
			cwd: this.#options.cwd,
			prompt: buildOrchestratorPrompt(this.#options.context(), messages),
			access: 'read-only',
			outputSchema: ORCHESTRATOR_RESULT_SCHEMA,
			signal,
			emit: () => {},
			eventPrefix: 'orchestrator',
			onSessionId: (assignedId) => {
				sessionId = assignedId;
				persistence.setOrchestratorSession(providerId, assignedId);
			},
		});
		persistence.setOrchestratorSession(providerId, sessionId);
		const parsed = parseOrchestratorResponse(result.structuredOutput);
		const assistant = persistence.appendOrchestratorMessage(
			providerId,
			'orchestrator',
			parsed.message,
		);
		if (parsed.command.type === 'none') {
			return { assistant, command: parsed.command, commandResult: null };
		}

		let commandText: string;
		try {
			commandText = await this.#options.execute(parsed.command);
		} catch (error) {
			commandText = `Comando recusado: ${errorMessage(error)}`;
		}
		const commandResult = persistence.appendOrchestratorMessage(
			providerId,
			'system',
			commandText,
		);
		return { assistant, command: parsed.command, commandResult };
	}
}
