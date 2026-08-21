// Localization grows by complete, typed product surfaces. en-US remains the
// only production-selected locale until every visible route is cataloged.

import type { OperatorAttention, RunProviderWaitView, RunState } from './run-view.ts';

export type Locale = 'en-US' | 'pt-BR';

export const DEFAULT_LOCALE: Locale = 'en-US';

export interface ShellCatalog {
	operatorNavigationLabel: string;
	skipLinkLabel: string;
	routeLabels: {
		conversation: string;
		runs: string;
		work: string;
		settings: string;
	};
}

export interface ConversationCatalog {
	transcriptLabel: string;
	emptyStateGuidance: string;
	roleLabels: {
		operator: string;
		orchestrator: string;
	};
	title: string;
	description: string;
	costSummary: (turnCount: number, formattedCost: string) => string;
	waitingDecisionPrompt: string;
	response: {
		label: string;
		placeholder: string;
		button: string;
	};
	composer: {
		label: string;
		placeholder: string;
		button: string;
	};
}

export interface RunInspectorCatalog {
	homeAccessibleLabel: string;
	currentRunTitle: string;
	latestRunTitle: string;
	viewDetailsLabel: string;
	noRunLabel: string;
	stateLabels: Readonly<Record<RunState, string>>;
	phaseLabel: (phase: string) => string;
	commandLabels: {
		resume: string;
		abandon: string;
		cancel: string;
		ship: string;
	};
	expectedCost: (formattedCost: string) => string;
	correctionRounds: (executor: number, decision: number, indeterminate: number) => string;
	providerHold: {
		accessibleLabel: string;
		title: (providerName: string) => string;
		retryBefore: string;
		retryAfter: string;
		waitReasons: Readonly<Record<RunProviderWaitView['kind'], string>>;
	};
	report: {
		title: string;
		description: string;
	};
	attentionLabels: Readonly<Record<OperatorAttention, string>>;
}

export interface RunsOperationalCatalog {
	cost: {
		title: string;
		description: string;
		roleLabels: {
			executor: string;
			reviewer: string;
		};
		tokenLabels: {
			input: string;
			output: string;
			cacheRead: string;
			cacheCreated: string;
		};
		tokensSuffix: string;
		effort: (value: string) => string;
		thinking: (count: number) => string;
	};
	activity: {
		title: string;
		description: (count: number) => string;
		toolsLabel: string;
	};
	workspaces: {
		title: string;
		description: (count: number) => string;
	};
	previousRuns: {
		title: string;
		description: (count: number) => string;
	};
}

export interface LocaleCatalog {
	shell: ShellCatalog;
	conversation: ConversationCatalog;
	runInspector: RunInspectorCatalog;
	runsOperational: RunsOperationalCatalog;
}

export const LOCALE_CATALOG = {
	'en-US': {
		shell: {
			operatorNavigationLabel: 'Operator surfaces',
			skipLinkLabel: 'Skip to content',
			routeLabels: {
				conversation: 'Conversation',
				runs: 'Runs',
				work: 'Work',
				settings: 'Settings',
			},
		},
		conversation: {
			transcriptLabel: 'Conversation transcript',
			emptyStateGuidance:
				'Describe the goal, ask for an investigation or give a command in natural language.',
			roleLabels: {
				operator: 'you',
				orchestrator: 'orchestrator',
			},
			title: 'Conversation with the orchestrator',
			description:
				'It can investigate the project; actions go through the deterministic runtime.',
			costSummary: (turnCount, formattedCost) =>
				`Expected cumulative cost for ${turnCount} ${turnCount === 1 ? 'orchestrator turn' : 'orchestrator turns'}: ${formattedCost}. API-equivalent usage, never the subscription charge.`,
			waitingDecisionPrompt: 'The run is waiting for your decision.',
			response: {
				label: 'Your response',
				placeholder: 'Decision or guidance for the agent',
				button: 'Respond and resume',
			},
			composer: {
				label: 'Message for the orchestrator',
				placeholder: 'What do you want to do now?',
				button: 'Send',
			},
		},
		runInspector: {
			homeAccessibleLabel: 'Run inspector',
			currentRunTitle: 'Current run',
			latestRunTitle: 'Latest run',
			viewDetailsLabel: 'View run details',
			noRunLabel: 'No runs recorded yet.',
			stateLabels: {
				queued: 'queued',
				working: 'working',
				verify: 'verify',
				review: 'review',
				'full-verify': 'full-verify',
				'ready-to-ship': 'ready-to-ship',
				shipping: 'shipping',
				done: 'done',
				'waiting-user': 'waiting-user',
				'waiting-provider': 'waiting-provider',
				failed: 'failed',
				interrupted: 'interrupted',
				cancelled: 'cancelled',
			},
			phaseLabel: (phase) => `Phase ${phase}`,
			commandLabels: {
				resume: 'Resume',
				abandon: 'Abandon',
				cancel: 'Cancel',
				ship: 'Ship',
			},
			expectedCost: (formattedCost) => `Expected cost: ${formattedCost}`,
			correctionRounds: (executor, decision, indeterminate) => {
				const total = executor + decision + indeterminate;
				const parts = [
					`${executor} from the executor`,
					`${decision} from ${decision === 1 ? 'an operator decision' : 'operator decisions'}`,
				];
				if (indeterminate > 0) {
					parts.push(`${indeterminate} with indeterminate ${indeterminate === 1 ? 'origin' : 'origins'}`);
				}
				return `${total === 1 ? 'Correction round' : 'Correction rounds'}: ${parts.join(', ')}`;
			},
			providerHold: {
				accessibleLabel: 'Provider on hold',
				title: (providerName) => `${providerName} on hold`,
				retryBefore: 'Try again after ',
				retryAfter: '.',
				waitReasons: {
					'auth-required': 'Authentication required',
					'usage-limit': 'Subscription usage limit reached',
					'rate-limited': 'Calls temporarily rate-limited',
					overloaded: 'Provider temporarily overloaded',
					'model-refused': 'Model or effort rejected',
					'transport-unavailable': 'Provider connection unavailable',
					'protocol-invalid': 'Invalid provider response',
					cancelled: 'Call cancelled',
					unknown: 'Provider unavailable',
				},
			},
			report: {
				title: 'Summary and diagnostics',
				description: "The complete runtime report and the run's technical identifier.",
			},
			attentionLabels: {
				'Needs you': 'Needs you',
				Working: 'Working',
				Idle: 'Idle',
			},
		},
		runsOperational: {
			cost: {
				title: 'Cost by role and model',
				description:
					'Expected API-equivalent usage cost by role and model. Never the amount charged to the subscription.',
				roleLabels: {
					executor: 'Executor',
					reviewer: 'Reviewer',
				},
				tokenLabels: {
					input: 'input',
					output: 'output',
					cacheRead: 'cache read',
					cacheCreated: 'cache created',
				},
				tokensSuffix: 'tokens',
				effort: (value) => ` (${value})`,
				thinking: (count) => `${count} thinking`,
			},
			activity: {
				title: 'Activity',
				description: (count) =>
					`${count} ${count === 1 ? 'recent event' : 'recent events'} from this run.`,
				toolsLabel: 'Tools',
			},
			workspaces: {
				title: 'Preserved workspaces',
				description: (count) =>
					`${count} ${count === 1 ? 'local resource needs' : 'local resources need'} inspection.`,
			},
			previousRuns: {
				title: 'Previous runs',
				description: (count) =>
					`${count} ${count === 1 ? 'run' : 'runs'} before the latest, newest first.`,
			},
		},
	},
	'pt-BR': {
		shell: {
			operatorNavigationLabel: 'Superfícies do operador',
			skipLinkLabel: 'Pular para o conteúdo',
			routeLabels: {
				conversation: 'Conversa',
				runs: 'Runs',
				work: 'Trabalho',
				settings: 'Ajustes',
			},
		},
		conversation: {
			transcriptLabel: 'Transcrição da conversa',
			emptyStateGuidance:
				'Descreva o objetivo, peça uma investigação ou dê um comando em linguagem natural.',
			roleLabels: {
				operator: 'você',
				orchestrator: 'orquestrador',
			},
			title: 'Conversa com o orquestrador',
			description:
				'Ele pode investigar o projeto; as ações passam pelo runtime determinístico.',
			costSummary: (turnCount, formattedCost) =>
				`Custo cumulativo esperado para ${turnCount} ${turnCount === 1 ? 'turno do orquestrador' : 'turnos do orquestrador'}: ${formattedCost}. Uso equivalente à API, nunca a cobrança da assinatura.`,
			waitingDecisionPrompt: 'A execução está aguardando sua decisão.',
			response: {
				label: 'Sua resposta',
				placeholder: 'Decisão ou orientação para o agente',
				button: 'Responder e retomar',
			},
			composer: {
				label: 'Mensagem para o orquestrador',
				placeholder: 'O que você quer fazer agora?',
				button: 'Enviar',
			},
		},
		runInspector: {
			homeAccessibleLabel: 'Inspetor da execução',
			currentRunTitle: 'Execução atual',
			latestRunTitle: 'Execução mais recente',
			viewDetailsLabel: 'Ver detalhes da execução',
			noRunLabel: 'Nenhuma execução registrada ainda.',
			stateLabels: {
				queued: 'na fila',
				working: 'em andamento',
				verify: 'verificação',
				review: 'revisão',
				'full-verify': 'verificação completa',
				'ready-to-ship': 'pronta para envio',
				shipping: 'enviando',
				done: 'concluída',
				'waiting-user': 'aguardando você',
				'waiting-provider': 'aguardando provedor',
				failed: 'falhou',
				interrupted: 'interrompida',
				cancelled: 'cancelada',
			},
			phaseLabel: (phase) => `Fase ${phase}`,
			commandLabels: {
				resume: 'Retomar',
				abandon: 'Abandonar',
				cancel: 'Cancelar',
				ship: 'Enviar',
			},
			expectedCost: (formattedCost) => `Custo esperado: ${formattedCost}`,
			correctionRounds: (executor, decision, indeterminate) => {
				const total = executor + decision + indeterminate;
				const parts = [
					`${executor} do executor`,
					`${decision} ${decision === 1 ? 'de uma decisão do operador' : 'de decisões do operador'}`,
				];
				if (indeterminate > 0) {
					parts.push(`${indeterminate} ${indeterminate === 1 ? 'indeterminada' : 'indeterminadas'}`);
				}
				return `${total === 1 ? 'Rodada de correção' : 'Rodadas de correção'}: ${parts.join(', ')}`;
			},
			providerHold: {
				accessibleLabel: 'Provedor em espera',
				title: (providerName) => `${providerName} em espera`,
				retryBefore: 'Tente novamente após ',
				retryAfter: '.',
				waitReasons: {
					'auth-required': 'Autenticação necessária',
					'usage-limit': 'Limite de uso da assinatura atingido',
					'rate-limited': 'Chamadas temporariamente limitadas',
					overloaded: 'Provedor temporariamente sobrecarregado',
					'model-refused': 'Modelo ou esforço rejeitado',
					'transport-unavailable': 'Conexão com o provedor indisponível',
					'protocol-invalid': 'Resposta inválida do provedor',
					cancelled: 'Chamada cancelada',
					unknown: 'Provedor indisponível',
				},
			},
			report: {
				title: 'Resumo e diagnósticos',
				description: 'O relatório completo do runtime e o identificador técnico da execução.',
			},
			attentionLabels: {
				'Needs you': 'Precisa de você',
				Working: 'Trabalhando',
				Idle: 'Ocioso',
			},
		},
		runsOperational: {
			cost: {
				title: 'Custo por função e modelo',
				description:
					'Custo esperado do uso equivalente à API por função e modelo. Nunca o valor cobrado na assinatura.',
				roleLabels: {
					executor: 'Executor',
					reviewer: 'Revisor',
				},
				tokenLabels: {
					input: 'entrada',
					output: 'saída',
					cacheRead: 'cache lido',
					cacheCreated: 'cache criado',
				},
				tokensSuffix: 'tokens',
				effort: (value) => ` (esforço ${value})`,
				thinking: (count) => `${count} de raciocínio`,
			},
			activity: {
				title: 'Atividade',
				description: (count) =>
					`${count} ${count === 1 ? 'evento recente' : 'eventos recentes'} desta execução.`,
				toolsLabel: 'Ferramentas',
			},
			workspaces: {
				title: 'Workspaces preservados',
				description: (count) =>
					`${count} ${count === 1 ? 'recurso local precisa' : 'recursos locais precisam'} de inspeção.`,
			},
			previousRuns: {
				title: 'Execuções anteriores',
				description: (count) =>
					`${count} ${count === 1 ? 'execução' : 'execuções'} antes da mais recente, da mais nova para a mais antiga.`,
			},
		},
	},
} as const satisfies Record<Locale, LocaleCatalog>;
