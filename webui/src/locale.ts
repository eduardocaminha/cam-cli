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

export interface RunsWorkflowCatalog {
	signals: {
		title: string;
		description: (runCount: number) => string;
		outcomesLabel: string;
		outcomes: (done: number, failed: number, cancelled: number, active: number) => string;
		correctionsLabel: string;
		corrections: (
			roundCount: number,
			runCount: number,
			executor: number,
			decision: number,
			indeterminate: number,
		) => string;
		knownCostLabel: string;
		noReportedCost: string;
		reportedCost: (formattedCost: string, reportedRunCount: number, runCount: number) => string;
	};
	benchmarks: {
		title: string;
		description: string;
		latestCohortLabel: string;
		previousBaselineLabel: string;
		emptyGuidance: string;
		singleCohortGuidance: string;
		observationalDisclaimer: string;
		card: {
			terminalSampleLabel: string;
			terminalSample: (runCount: number, incompleteRunCount: number) => string;
			outcomesLabel: string;
			outcomes: (shipped: number, failed: number, cancelled: number) => string;
			humanAttentionLabel: string;
			humanAttention: (requests: number, runCount: number, responses: number) => string;
			correctionsLabel: string;
			corrections: (roundCount: number, runCount: number) => string;
			providerHoldsLabel: string;
			providerHolds: (holdCount: number, runCount: number) => string;
			medianTimeLabel: string;
			medianTime: (wallTime: string) => string;
			knownCostLabel: string;
			noReportedCost: string;
			reportedCost: (formattedCost: string, runCount: number) => string;
			configurationMissing: string;
			modelMissing: string;
			wallTime: {
				notRecorded: string;
				lessThanMinute: string;
				minutes: (count: number) => string;
				hours: (count: number) => string;
			};
		};
	};
}

export interface LocaleCatalog {
	shell: ShellCatalog;
	conversation: ConversationCatalog;
	runInspector: RunInspectorCatalog;
	runsOperational: RunsOperationalCatalog;
	runsWorkflow: RunsWorkflowCatalog;
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
		runsWorkflow: {
			signals: {
				title: 'Workflow signals',
				description: (runCount) =>
					`Local window of the latest ${runCount} ${runCount === 1 ? 'run' : 'runs'}, without a composite score.`,
				outcomesLabel: 'Outcomes',
				outcomes: (done, failed, cancelled, active) =>
					`${done} completed · ${failed} failed · ${cancelled} cancelled${active === 0 ? '' : ` · ${active} active`}`,
				correctionsLabel: 'Corrections',
				corrections: (roundCount, runCount, executor, decision, indeterminate) =>
					`${roundCount} ${roundCount === 1 ? 'round' : 'rounds'} across ${runCount} ${runCount === 1 ? 'run' : 'runs'}: ${executor} automatic, ${decision} after ${decision === 1 ? 'a human decision' : 'human decisions'}${indeterminate === 0 ? '' : `, ${indeterminate} with indeterminate origin`}`,
				knownCostLabel: 'Known cost',
				noReportedCost: 'No provider reported cost in this window.',
				reportedCost: (formattedCost, reportedRunCount, runCount) =>
					`${formattedCost} across ${reportedRunCount} of ${runCount} ${runCount === 1 ? 'run' : 'runs'}.`,
			},
			benchmarks: {
				title: 'Replayable benchmarks',
				description:
					'Replays the durable window of up to 50 runs and compares revisions without calling another agent.',
				latestCohortLabel: 'Latest cohort',
				previousBaselineLabel: 'Previous baseline',
				emptyGuidance:
					'Existing runs predate revision tracking. The next run starts the first cohort.',
				singleCohortGuidance:
					'Comparison begins when another revision accumulates a terminal run.',
				observationalDisclaimer:
					'Observational comparison: scope, provider, model and effort may also change outcomes. There is no composite score or automatic approval.',
				card: {
					terminalSampleLabel: 'Terminal sample',
					terminalSample: (runCount, incompleteRunCount) =>
						`${runCount} ${runCount === 1 ? 'run' : 'runs'}${incompleteRunCount === 0 ? '' : ` · ${incompleteRunCount} ${incompleteRunCount === 1 ? 'run' : 'runs'} still incomplete`}`,
					outcomesLabel: 'Outcomes',
					outcomes: (shipped, failed, cancelled) =>
						`${shipped} shipped · ${failed} failed · ${cancelled} cancelled`,
					humanAttentionLabel: 'Human attention',
					humanAttention: (requests, runCount, responses) =>
						`${requests} ${requests === 1 ? 'request' : 'requests'} across ${runCount} ${runCount === 1 ? 'run' : 'runs'} · ${responses} ${responses === 1 ? 'response' : 'responses'}`,
					correctionsLabel: 'Corrections',
					corrections: (roundCount, runCount) =>
						`${roundCount} ${roundCount === 1 ? 'round' : 'rounds'} across ${runCount} ${runCount === 1 ? 'run' : 'runs'}`,
					providerHoldsLabel: 'Provider holds',
					providerHolds: (holdCount, runCount) =>
						`${holdCount} ${holdCount === 1 ? 'hold' : 'holds'} across ${runCount} ${runCount === 1 ? 'run' : 'runs'}`,
					medianTimeLabel: 'Median time',
					medianTime: (wallTime) => `${wallTime} from creation to terminal state`,
					knownCostLabel: 'Known cost',
					noReportedCost: 'no reported cost',
					reportedCost: (formattedCost, runCount) =>
						`${formattedCost} across ${runCount} ${runCount === 1 ? 'run' : 'runs'}`,
					configurationMissing: 'Provider/model/effort not yet observed in a terminal run.',
					modelMissing: 'model not recorded',
					wallTime: {
						notRecorded: 'not recorded',
						lessThanMinute: 'less than 1 min',
						minutes: (count) => `${count} min`,
						hours: (count) => `${new Intl.NumberFormat('en-US', {
							maximumFractionDigits: 1,
						}).format(count)} h`,
					},
				},
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
		runsWorkflow: {
			signals: {
				title: 'Sinais do fluxo de trabalho',
				description: (runCount) =>
					`Janela local das ${runCount} ${runCount === 1 ? 'execução mais recente' : 'execuções mais recentes'}, sem pontuação composta.`,
				outcomesLabel: 'Resultados',
				outcomes: (done, failed, cancelled, active) =>
					`${done} concluída${done === 1 ? '' : 's'} · ${failed} com falha · ${cancelled} cancelada${cancelled === 1 ? '' : 's'}${active === 0 ? '' : ` · ${active} ativa${active === 1 ? '' : 's'}`}`,
				correctionsLabel: 'Correções',
				corrections: (roundCount, runCount, executor, decision, indeterminate) =>
					`${roundCount} ${roundCount === 1 ? 'rodada' : 'rodadas'} em ${runCount} ${runCount === 1 ? 'execução' : 'execuções'}: ${executor} automática${executor === 1 ? '' : 's'}, ${decision} após ${decision === 1 ? 'uma decisão humana' : 'decisões humanas'}${indeterminate === 0 ? '' : `, ${indeterminate} de origem indeterminada`}`,
				knownCostLabel: 'Custo conhecido',
				noReportedCost: 'Nenhum provedor informou custo nesta janela.',
				reportedCost: (formattedCost, reportedRunCount, runCount) =>
					`${formattedCost} em ${reportedRunCount} de ${runCount} ${runCount === 1 ? 'execução' : 'execuções'}.`,
			},
			benchmarks: {
				title: 'Benchmarks reproduzíveis',
				description:
					'Reproduz a janela durável de até 50 execuções e compara revisões sem chamar outro agente.',
				latestCohortLabel: 'Coorte mais recente',
				previousBaselineLabel: 'Referência anterior',
				emptyGuidance:
					'As execuções existentes são anteriores ao rastreamento de revisões. A próxima execução inicia a primeira coorte.',
				singleCohortGuidance:
					'A comparação começa quando outra revisão acumular uma execução terminal.',
				observationalDisclaimer:
					'Comparação observacional: escopo, provedor, modelo e esforço também podem alterar os resultados. Não há pontuação composta nem aprovação automática.',
				card: {
					terminalSampleLabel: 'Amostra terminal',
					terminalSample: (runCount, incompleteRunCount) =>
						`${runCount} ${runCount === 1 ? 'execução' : 'execuções'}${incompleteRunCount === 0 ? '' : ` · ${incompleteRunCount} ${incompleteRunCount === 1 ? 'execução ainda incompleta' : 'execuções ainda incompletas'}`}`,
					outcomesLabel: 'Resultados',
					outcomes: (shipped, failed, cancelled) =>
						`${shipped} enviada${shipped === 1 ? '' : 's'} · ${failed} com falha · ${cancelled} cancelada${cancelled === 1 ? '' : 's'}`,
					humanAttentionLabel: 'Atenção humana',
					humanAttention: (requests, runCount, responses) =>
						`${requests} ${requests === 1 ? 'solicitação' : 'solicitações'} em ${runCount} ${runCount === 1 ? 'execução' : 'execuções'} · ${responses} ${responses === 1 ? 'resposta' : 'respostas'}`,
					correctionsLabel: 'Correções',
					corrections: (roundCount, runCount) =>
						`${roundCount} ${roundCount === 1 ? 'rodada' : 'rodadas'} em ${runCount} ${runCount === 1 ? 'execução' : 'execuções'}`,
					providerHoldsLabel: 'Esperas do provedor',
					providerHolds: (holdCount, runCount) =>
						`${holdCount} ${holdCount === 1 ? 'espera' : 'esperas'} em ${runCount} ${runCount === 1 ? 'execução' : 'execuções'}`,
					medianTimeLabel: 'Tempo mediano',
					medianTime: (wallTime) => `${wallTime} da criação ao estado terminal`,
					knownCostLabel: 'Custo conhecido',
					noReportedCost: 'nenhum custo informado',
					reportedCost: (formattedCost, runCount) =>
						`${formattedCost} em ${runCount} ${runCount === 1 ? 'execução' : 'execuções'}`,
					configurationMissing: 'Provedor/modelo/esforço ainda não observado em uma execução terminal.',
					modelMissing: 'modelo não registrado',
					wallTime: {
						notRecorded: 'não registrado',
						lessThanMinute: 'menos de 1 min',
						minutes: (count) => `${count} min`,
						hours: (count) => `${new Intl.NumberFormat('pt-BR', {
							maximumFractionDigits: 1,
						}).format(count)} h`,
					},
				},
			},
		},
	},
} as const satisfies Record<Locale, LocaleCatalog>;
