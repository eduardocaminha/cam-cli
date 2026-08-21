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
	correctionRounds: (executor: number, decision: number, orchestrator: number, indeterminate: number) => string;
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
			orchestrator: string;
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
		cycleResponseLabel: string;
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
			orchestrator: number,
			indeterminate: number,
		) => string;
		cycleResponsesLabel: string;
		cycleResponses: (responses: number, runCount: number) => string;
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
			cycleResponsesLabel: string;
			cycleResponses: (responses: number, runCount: number) => string;
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

export interface WorkCatalog {
	backlog: {
		title: string;
		description: (count: number, formattedCount: string) => string;
		start: string;
	};
	form: {
		title: string;
		scope: string;
		verificationCommand: string;
		verificationPlaceholder: string;
		promote: string;
	};
	intake: {
		title: string;
		description: string;
		create: string;
	};
	specification: {
		title: string;
		description: string;
		idea: string;
		submit: string;
	};
	review: {
		title: string;
		description: (count: number, formattedCount: string) => string;
		draft: string;
		selectDraft: string;
		stateLabels: Readonly<Record<'draft' | 'approved' | 'stale', string>>;
		ownedByRun: (issueId: string) => string;
		evidence: string;
		saveRevision: string;
		confirmPersisted: string;
		approve: string;
		abandonReason: string;
		confirmAbandon: (issueId: string) => string;
		abandon: string;
	};
	diagnostics: {
		title: string;
		analyzing: string;
		pendingCount: (count: number, formattedCount: string) => string;
		running: string;
		advisory: string;
		analyzerDescriptions: Readonly<Record<'react', string>>;
		scanStateLabels: Readonly<Record<'queued' | 'running' | 'completed' | 'failed' | 'cancelled', string>>;
		partial: string;
		runNow: string;
		cancel: string;
		severityLabels: Readonly<Record<'error' | 'warning' | 'info', string>>;
		statusLabels: Readonly<Record<'pending' | 'dismissed' | 'promoted' | 'cleared', string>>;
		occurrences: (formattedCount: string) => string;
		toolVersion: (version: string) => string;
		dismiss: string;
		defaultIssueTitle: (rule: string, file: string) => string;
		noPending: string;
		resolved: (formattedCount: string) => string;
		omitted: (formattedCount: string) => string;
		noHistory: string;
		history: (promoted: string, dismissed: string, cleared: string, pending: string) => string;
		recurring: (count: number, formattedCount: string) => string;
		dismissalDisclaimer: string;
	};
	proposals: {
		pendingTitle: string;
		pendingCount: (count: number, formattedCount: string) => string;
		emptyPending: string;
		dismiss: string;
		resolvedTitle: string;
		resolvedCount: (count: number, formattedCount: string) => string;
		readOnly: string;
		settledNote: string;
		emptyResolved: string;
		statusLabels: Readonly<Record<'promoted' | 'dismissed', string>>;
		became: string;
		omitted: (count: number, formattedCount: string) => string;
	};
}

export interface LocaleCatalog {
	shell: ShellCatalog;
	conversation: ConversationCatalog;
	runInspector: RunInspectorCatalog;
	runsOperational: RunsOperationalCatalog;
	runsWorkflow: RunsWorkflowCatalog;
	work: WorkCatalog;
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
			correctionRounds: (executor, decision, orchestrator, indeterminate) => {
				const total = executor + decision + orchestrator + indeterminate;
				const parts = [
					`${executor} from the executor`,
					`${decision} from ${decision === 1 ? 'an operator decision' : 'operator decisions'}`,
					`${orchestrator} resolved by the orchestrator`,
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
					orchestrator: 'Orchestrator',
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
				cycleResponseLabel: 'Orchestrator answer to the review cycle',
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
				corrections: (roundCount, runCount, executor, decision, orchestrator, indeterminate) =>
					`${roundCount} ${roundCount === 1 ? 'round' : 'rounds'} across ${runCount} ${runCount === 1 ? 'run' : 'runs'}: ${executor} automatic, ${orchestrator} orchestrator-resolved, ${decision} after ${decision === 1 ? 'a human decision' : 'human decisions'}${indeterminate === 0 ? '' : `, ${indeterminate} with indeterminate origin`}`,
				cycleResponsesLabel: 'Orchestrator cycle responses',
				cycleResponses: (responses, runCount) => `${responses} ${responses === 1 ? 'response' : 'responses'} across ${runCount} ${runCount === 1 ? 'run' : 'runs'}`,
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
					cycleResponsesLabel: 'Orchestrator cycle responses',
					cycleResponses: (responses, runCount) => `${responses} ${responses === 1 ? 'response' : 'responses'} across ${runCount} ${runCount === 1 ? 'run' : 'runs'}`,
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
		work: {
			backlog: {
				title: 'Executable backlog',
				description: (count, formattedCount) =>
					`${formattedCount} ${count === 1 ? 'admissible issue' : 'admissible issues'} right now.`,
				start: 'Start run',
			},
			form: {
				title: 'Title',
				scope: 'Scope and expected outcome',
				verificationCommand: 'Verification command',
				verificationPlaceholder: 'bun test',
				promote: 'Promote',
			},
			intake: {
				title: 'New issue',
				description: 'Goes directly to the executable backlog; the command is the deterministic gate.',
				create: 'Create issue',
			},
			specification: {
				title: 'Specify existing idea',
				description: 'Promotes the idea with the same direct contract, without an intermediate planner.',
				idea: 'Idea',
				submit: 'Specify idea',
			},
			review: {
				title: 'Review and approve',
				description: (count, formattedCount) =>
					`${formattedCount} ${count === 1 ? 'open and specified issue' : 'open and specified issues'}.`,
				draft: 'Draft',
				selectDraft: 'Select a draft',
				stateLabels: { draft: 'draft', approved: 'approved', stale: 'stale' },
				ownedByRun: (issueId) => `${issueId} is being executed by a run. The issue file belongs to it until the run ends, so review, approval and abandonment return only after that.`,
				evidence: 'Evidence checked in the run workspace',
				saveRevision: 'Save revision',
				confirmPersisted: 'I confirm the persisted scope and verificationCommand.',
				approve: 'Approve',
				abandonReason: 'Reason for abandonment',
				confirmAbandon: (issueId) => `I confirm abandoning ${issueId} for this reason.`,
				abandon: 'Abandon',
			},
			diagnostics: {
				title: 'Gateship Diagnostics',
				analyzing: 'Analyzing an isolated checkout…',
				pendingCount: (count, formattedCount) => `${formattedCount} ${count === 1 ? 'pending finding' : 'pending findings'}.`,
				running: 'running',
				advisory: "Advisory: never fixes, approves or blocks shipping. The first run downloads the pinned analyzer only into Gateship's local state.",
				analyzerDescriptions: {
					react: 'Errors, security, performance and accessibility in React projects.',
				},
				scanStateLabels: { queued: 'queued', running: 'running', completed: 'completed', failed: 'failed', cancelled: 'cancelled' },
				partial: 'partial',
				runNow: 'Run now',
				cancel: 'Cancel diagnostic',
				severityLabels: { error: 'error', warning: 'warning', info: 'info' },
				statusLabels: { pending: 'Pending', dismissed: 'Dismissed', promoted: 'Promoted', cleared: 'Did not recur' },
				occurrences: (formattedCount) => `×${formattedCount}`,
				toolVersion: (version) => `tool ${version}`,
				dismiss: 'Dismiss',
				defaultIssueTitle: (rule, file) => `${rule} in ${file}`,
				noPending: 'No pending findings.',
				resolved: (formattedCount) => `Resolved (${formattedCount})`,
				omitted: (formattedCount) => `+${formattedCount} not shown.`,
				noHistory: "There is not enough history yet to measure this analyzer's usefulness.",
				history: (promoted, dismissed, cleared, pending) => `Local history: ${promoted} promoted, ${dismissed} dismissed, ${cleared} that did not recur and ${pending} pending.`,
				recurring: (count, formattedCount) => `${formattedCount} ${count === 1 ? 'finding' : 'findings'} recurred in another scan.`,
				dismissalDisclaimer: 'Dismissal does not mean false positive; that can only be measured when the operator explicitly classifies the reason.',
			},
			proposals: {
				pendingTitle: 'Derived proposals',
				pendingCount: (count, formattedCount) => `${formattedCount} ${count === 1 ? 'pending proposal' : 'pending proposals'}.`,
				emptyPending: 'No pending proposals. A run records out-of-scope discoveries here.',
				dismiss: 'Dismiss',
				resolvedTitle: 'Resolved proposals',
				resolvedCount: (count, formattedCount) => `${formattedCount} ${count === 1 ? 'resolved proposal' : 'resolved proposals'}.`,
				readOnly: 'read-only',
				settledNote: 'Dismissal and promotion cannot be undone here.',
				emptyResolved: 'No resolved proposals yet.',
				statusLabels: { promoted: 'Promoted', dismissed: 'Dismissed' },
				became: 'became',
				omitted: (count, formattedCount) => `+${formattedCount} ${count === 1 ? 'resolved proposal' : 'resolved proposals'} not shown.`,
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
			correctionRounds: (executor, decision, orchestrator, indeterminate) => {
				const total = executor + decision + orchestrator + indeterminate;
				const parts = [
					`${executor} do executor`,
					`${decision} ${decision === 1 ? 'de uma decisão do operador' : 'de decisões do operador'}`,
					`${orchestrator} resolvida${orchestrator === 1 ? '' : 's'} pelo orquestrador`,
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
					orchestrator: 'Orquestrador',
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
				cycleResponseLabel: 'Resposta do orquestrador ao ciclo de revisão',
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
				corrections: (roundCount, runCount, executor, decision, orchestrator, indeterminate) =>
					`${roundCount} ${roundCount === 1 ? 'rodada' : 'rodadas'} em ${runCount} ${runCount === 1 ? 'execução' : 'execuções'}: ${executor} automática${executor === 1 ? '' : 's'}, ${orchestrator} resolvida${orchestrator === 1 ? '' : 's'} pelo orquestrador, ${decision} após ${decision === 1 ? 'uma decisão humana' : 'decisões humanas'}${indeterminate === 0 ? '' : `, ${indeterminate} de origem indeterminada`}`,
				cycleResponsesLabel: 'Respostas do orquestrador ao ciclo',
				cycleResponses: (responses, runCount) => `${responses} ${responses === 1 ? 'resposta' : 'respostas'} em ${runCount} ${runCount === 1 ? 'execução' : 'execuções'}`,
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
					cycleResponsesLabel: 'Respostas do orquestrador ao ciclo',
					cycleResponses: (responses, runCount) => `${responses} ${responses === 1 ? 'resposta' : 'respostas'} em ${runCount} ${runCount === 1 ? 'execução' : 'execuções'}`,
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
		work: {
			backlog: {
				title: 'Backlog executável',
				description: (count, formattedCount) =>
					`${formattedCount} ${count === 1 ? 'issue admissível' : 'issues admissíveis'} agora.`,
				start: 'Iniciar execução',
			},
			form: {
				title: 'Título',
				scope: 'Escopo e resultado esperado',
				verificationCommand: 'Comando de verificação',
				verificationPlaceholder: 'bun test',
				promote: 'Promover',
			},
			intake: {
				title: 'Nova issue',
				description: 'Vai diretamente para o backlog executável; o comando é o controle determinístico.',
				create: 'Criar issue',
			},
			specification: {
				title: 'Especificar ideia existente',
				description: 'Promove a ideia com o mesmo contrato direto, sem um planejador intermediário.',
				idea: 'Ideia',
				submit: 'Especificar ideia',
			},
			review: {
				title: 'Revisar e aprovar',
				description: (count, formattedCount) =>
					`${formattedCount} ${count === 1 ? 'issue aberta e especificada' : 'issues abertas e especificadas'}.`,
				draft: 'Rascunho',
				selectDraft: 'Selecione um rascunho',
				stateLabels: { draft: 'rascunho', approved: 'aprovada', stale: 'desatualizada' },
				ownedByRun: (issueId) => `${issueId} está sendo executada por uma execução. O arquivo da issue pertence a ela até a execução terminar; depois disso, revisão, aprovação e abandono voltam a ficar disponíveis.`,
				evidence: 'Evidências verificadas no workspace da execução',
				saveRevision: 'Salvar revisão',
				confirmPersisted: 'Confirmo o escopo e o verificationCommand persistidos.',
				approve: 'Aprovar',
				abandonReason: 'Motivo do abandono',
				confirmAbandon: (issueId) => `Confirmo o abandono de ${issueId} por este motivo.`,
				abandon: 'Abandonar',
			},
			diagnostics: {
				title: 'Diagnósticos do Gateship',
				analyzing: 'Analisando um checkout isolado…',
				pendingCount: (count, formattedCount) => `${formattedCount} ${count === 1 ? 'achado pendente' : 'achados pendentes'}.`,
				running: 'em andamento',
				advisory: 'Consultivo: nunca corrige, aprova nem bloqueia o envio. A primeira execução baixa o analisador fixado apenas no estado local do Gateship.',
				analyzerDescriptions: {
					react: 'Erros, segurança, desempenho e acessibilidade em projetos React.',
				},
				scanStateLabels: { queued: 'na fila', running: 'em andamento', completed: 'concluído', failed: 'falhou', cancelled: 'cancelado' },
				partial: 'parcial',
				runNow: 'Executar agora',
				cancel: 'Cancelar diagnóstico',
				severityLabels: { error: 'erro', warning: 'aviso', info: 'informação' },
				statusLabels: { pending: 'Pendente', dismissed: 'Descartado', promoted: 'Promovido', cleared: 'Não voltou a ocorrer' },
				occurrences: (formattedCount) => `×${formattedCount}`,
				toolVersion: (version) => `ferramenta ${version}`,
				dismiss: 'Descartar',
				defaultIssueTitle: (rule, file) => `${rule} em ${file}`,
				noPending: 'Nenhum achado pendente.',
				resolved: (formattedCount) => `Resolvidos (${formattedCount})`,
				omitted: (formattedCount) => `+${formattedCount} não exibidos.`,
				noHistory: 'Ainda não há histórico suficiente para medir a utilidade deste analisador.',
				history: (promoted, dismissed, cleared, pending) => `Histórico local: ${promoted} promovidos, ${dismissed} descartados, ${cleared} que não voltaram a ocorrer e ${pending} pendentes.`,
				recurring: (count, formattedCount) => `${formattedCount} ${count === 1 ? 'achado voltou' : 'achados voltaram'} a ocorrer em outra análise.`,
				dismissalDisclaimer: 'Descartar não significa falso positivo; isso só pode ser medido quando o operador classifica explicitamente o motivo.',
			},
			proposals: {
				pendingTitle: 'Propostas derivadas',
				pendingCount: (count, formattedCount) => `${formattedCount} ${count === 1 ? 'proposta pendente' : 'propostas pendentes'}.`,
				emptyPending: 'Nenhuma proposta pendente. Uma execução registra aqui as descobertas fora do escopo.',
				dismiss: 'Descartar',
				resolvedTitle: 'Propostas resolvidas',
				resolvedCount: (count, formattedCount) => `${formattedCount} ${count === 1 ? 'proposta resolvida' : 'propostas resolvidas'}.`,
				readOnly: 'somente leitura',
				settledNote: 'O descarte e a promoção não podem ser desfeitos aqui.',
				emptyResolved: 'Nenhuma proposta resolvida ainda.',
				statusLabels: { promoted: 'Promovida', dismissed: 'Descartada' },
				became: 'virou',
				omitted: (count, formattedCount) => `+${formattedCount} ${count === 1 ? 'proposta resolvida' : 'propostas resolvidas'} não exibidas.`,
			},
		},
	},
} as const satisfies Record<Locale, LocaleCatalog>;
