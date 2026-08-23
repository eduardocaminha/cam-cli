// Localization grows by complete, typed product surfaces.

import type { OperatorAttention, RunProviderWaitView, RunState } from './run-view.ts';

export type Locale = 'en-US' | 'pt-BR';

export const DEFAULT_LOCALE: Locale = 'en-US';
export const LOCALE_STORAGE_KEY = 'gateship.locale';

export function localeOf(value: string | null): Locale {
	return value === 'en-US' || value === 'pt-BR' ? value : DEFAULT_LOCALE;
}

export function readLocalePreference(read: () => string | null): Locale {
	try {
		return localeOf(read());
	} catch {
		return DEFAULT_LOCALE;
	}
}

export function applyLocalePreference(
	locale: Locale,
	setCurrentLocale: (locale: Locale) => void,
	persist: (key: string, locale: Locale) => void,
): void {
	setCurrentLocale(locale);
	try {
		persist(LOCALE_STORAGE_KEY, locale);
	} catch {
		// The current selection remains usable when persistence is unavailable.
	}
}

export interface ShellCatalog {
	operatorNavigationLabel: string;
	projectNavigationLabel: string;
	allProjectsLabel: string;
	skipLinkLabel: string;
	languageLabel: string;
	routeLabels: {
		conversation: string;
		runs: string;
		work: string;
		settings: string;
		globalSettings: string;
	};
}

export interface ProjectsCatalog {
	title: string;
	description: string;
	currentBadge: string;
	repositoryUnknown: string;
	readinessLabel: string;
	readiness: Readonly<Record<'ready' | 'empty' | 'needs-attention', string>>;
	unavailableTitle: string;
	unavailableDescription: string;
	notFoundTitle: string;
	notFoundDescription: string;
	/** Onboarding a checkout the operator already has, by absolute path. */
	register: {
		title: string;
		description: string;
		rootLabel: string;
		rootPlaceholder: string;
		rootGuidance: string;
		containerGuidance: string;
		submit: string;
	};
	/** Cloning a GitHub repository into a checkout Gateship manages and owns the location of. */
	import: {
		title: string;
		description: string;
		repositoryLabel: string;
		repositoryPlaceholder: string;
		destinationGuidance: string;
		credentialGuidance: string;
		submit: string;
		pending: string;
	};
	/** Creating a new GitHub repository and its Gateship-managed checkout. */
	create: {
		title: string;
		description: string;
		repositoryLabel: string;
		repositoryPlaceholder: string;
		descriptionLabel: string;
		descriptionPlaceholder: string;
		visibilityLabel: string;
		privateLabel: string;
		publicLabel: string;
		publicWarning: string;
		destinationGuidance: string;
		credentialGuidance: string;
		confirm: (repository: string, visibility: string) => string;
		submit: string;
		pending: string;
	};
	/** Dropping a registration, which is the whole operation: nothing is deleted. */
	remove: {
		title: string;
		description: string;
		filesRemain: string;
		confirm: (name: string) => string;
		submit: string;
	};
}

export interface OverviewCatalog {
	title: string;
	description: string;
	loading: string;
	empty: string;
	partial: string;
	error: string;
	metrics: { activeProjects: string; attention: string; backlog: string; completed: string; cost: string };
	activeRun: string;
	issue: string;
	phase: string;
	provider: string;
	updated: string;
	backlogLabel: string;
	lastOutcome: string;
	noRun: string;
	noOutcome: string;
	databaseUnavailable: string;
	historyUnavailable: string;
	noCost: string;
	costCoverage: (known: number, total: number) => string;
	trend: string;
	activity: string;
	outcomes: { shipped: string; failed: string; cancelled: string; incomplete: string };
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
	correctionRounds: (executor: number, ci: number, decision: number, orchestrator: number, indeterminate: number) => string;
	pullRequestLabel: (number: number) => string;
	ciCorrectionLabel: (checkName: string) => string;
	ciLabels: Readonly<Record<'not-reported' | 'pending' | 'passed' | 'failed', string>>;
	providerHold: {
		accessibleLabel: string;
		title: (providerName: string) => string;
		retryBefore: string;
		retryAfter: string;
		waitReasons: Readonly<Record<RunProviderWaitView['kind'], string>>;
	};
	/**
	 * GSHIP-722: reuses `providerHold.waitReasons` for the reason text -- the
	 * same enum, the same wording. `title` is shown only once the transfer
	 * actually happened; `refusedTitle` is shown when the one attempt was
	 * refused and the run stayed on its own origin, so the screen never claims
	 * a handoff that did not occur.
	 */
	executorHandoff: {
		accessibleLabel: string;
		title: (fromProviderName: string, toProviderName: string) => string;
		refusedTitle: (fromProviderName: string, toProviderName: string) => string;
		reasonPrefix: string;
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
			ci: number,
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

export interface SettingsCatalog {
	title: string;
	disclosure: { open: string; close: string };
	project: {
		title: string;
		description: string;
		stateLabels: { ready: string; checking: string; attention: string };
		localProject: string;
		repository: string;
		runSource: string;
	};
	operator: {
		title: string;
		description: string;
		name: string;
		namePlaceholder: string;
		timezone: string;
		timezonePlaceholder: string;
		timezoneGuidance: string;
		save: string;
	};
	providers: {
		title: string;
		description: string;
		inUse: string;
		connectedUnavailable: (reason: string) => string;
		unavailable: (reason: string) => string;
		connected: (plan?: string) => string;
		installedDisconnected: string;
		clientMissing: string;
		connectChatGpt: string;
		codexSubscriptionGuidance: string;
		codexApiKeyWarning: string;
		codexEnterpriseFuture: string;
		useProvider: (label: string) => string;
		waitReasons: Readonly<Record<RunProviderWaitView['kind'], string>>;
		usageWindowLabels: Readonly<Record<string, string>>;
		duration: { days: (count: number, formatted: string) => string; hours: (count: number, formatted: string) => string; minutes: (formatted: string) => string };
		usedPercent: (formatted: string) => string;
		resets: string;
		asOf: string;
		credits: string;
		unlimited: string;
		available: string;
		none: string;
		spendLimit: (used: string, limit: string, remainingPercent: string) => string;
		resetCredits: (count: number, formatted: string) => string;
		/** Ajustes > Providers universal onboarding for a dedicated Claude subscription (GSHIP-704), isolated from Claude Desktop's or the terminal's own OAuth/Keychain login. */
		claudeCredential: {
			recommendedTitle: string;
			recommendedGuidance: string;
			recommendedCommandLabel: string;
			usageGuidance: string;
			explanation: string;
			/** GSHIP-705: what the check actually proves, and why no account may be promised with it. */
			inferenceOnly: string;
			cliMissing: string;
			setupCommandLabel: string;
			copyCommand: string;
			tokenLabel: string;
			tokenPlaceholder: string;
			confirm: string;
			connect: string;
			rotate: string;
			cancel: string;
			disconnect: string;
			connected: string;
			needsReconnect: string;
			envManaged: string;
			advancedTitle: string;
			originLabels: Readonly<Record<'external' | 'web' | 'dedicated', string>>;
		};
	};
	models: {
		title: string;
		description: string;
		roleLabels: Readonly<Record<'orchestrator' | 'executor' | 'reviewer', string>>;
		model: string;
		effort: string;
		cliDefault: string;
		documentation: (provider: string) => string;
		save: string;
	};
	chain: { title: string; description: string; label: string };
	executorHandoff: { title: string; description: string; label: string };
	updates: {
		title: string;
		description: string;
		label: string;
		guidance: string;
		available: string;
		unknown: string;
		statusLabels: Readonly<Record<'success' | 'rollback' | 'failed' | 'check-failed' | 'deferred', string>>;
		result: (previous: string, target: string, at: string) => string;
	};
	diagnostics: {
		title: string;
		description: string;
		label: string;
		cadence: string;
		cadenceLabels: Readonly<Record<'daily' | 'weekly', string>>;
		disabled: string;
		overdue: string;
		nextRun: (value: string) => string;
		calculating: string;
		guidance: string;
		save: string;
	};
	notifications: {
		title: string;
		description: string;
		permissionStates: Readonly<Record<'granted' | 'denied' | 'unsupported' | 'default', string>>;
		actionLabels: Readonly<Record<'granted' | 'denied' | 'unsupported' | 'default', string>>;
		channelLabels: Readonly<Record<'ntfy' | 'resend', string>>;
		configured: string;
		notConfigured: string;
		missing: (values: string) => string;
		sendTest: string;
		resendFields: Readonly<Record<'from' | 'to' | 'apiKey', string>>;
		resendPlaceholders: Readonly<Record<'from' | 'to' | 'apiKey', string>>;
		saveResend: string;
		removeResendCredential: string;
		externallyManaged: string;
		fileCredentialPresent: string;
		fileCredentialAbsent: string;
		instructions: Readonly<Record<'ntfy' | 'resend', string>>;
		docLabels: Readonly<Record<'ntfy' | 'resendApiKeys' | 'resendDomain', string>>;
	};
	brief: {
		title: string;
		description: string;
		fieldLabels: Readonly<Record<'objective' | 'decisions' | 'constraints' | 'openItems', string>>;
		linePlaceholder: string;
		save: string;
	};
	handoff: {
		title: string;
		description: string;
		readOnly: string;
		rewritten: string;
		nothingRecorded: string;
	};
}

export interface OnboardingCatalog {
	title: string;
	cardTitle: string;
	description: string;
	existingProject: { title: string; guidance: string };
	newProject: { title: string; guidance: string };
	incompleteBadge: string;
	recoveryGuidance: string;
	settingsGuidance: { beforeLink: string; linkLabel: string; afterLink: string };
}

export interface LocaleCatalog {
	shell: ShellCatalog;
	projects: ProjectsCatalog;
	overview: OverviewCatalog;
	conversation: ConversationCatalog;
	runInspector: RunInspectorCatalog;
	runsOperational: RunsOperationalCatalog;
	runsWorkflow: RunsWorkflowCatalog;
	work: WorkCatalog;
	settings: SettingsCatalog;
	onboarding: OnboardingCatalog;
}

export const LOCALE_CATALOG = {
	'en-US': {
		shell: {
			operatorNavigationLabel: 'Operator surfaces',
			projectNavigationLabel: 'Projects',
			allProjectsLabel: 'All projects',
			skipLinkLabel: 'Skip to content',
			languageLabel: 'Language',
			routeLabels: {
				conversation: 'Conversation',
				runs: 'Runs',
				work: 'Work',
				settings: 'Settings',
				globalSettings: 'Global settings',
			},
		},
		projects: {
			title: 'All projects',
			description: 'Registered projects available to this Gateship installation.',
			currentBadge: 'served by this instance',
			repositoryUnknown: 'Repository not known',
			readinessLabel: 'Readiness',
			readiness: { ready: 'ready', empty: 'empty', 'needs-attention': 'needs attention' },
			unavailableTitle: 'Project runtime not loaded',
			unavailableDescription: 'This project is registered, but its runtime is not loaded in this Gateship instance.',
			notFoundTitle: 'Project not registered',
			notFoundDescription: 'This URL does not match a registered project.',
			register: {
				title: 'Register an existing checkout',
				description: 'Gateship only registers a clone that already has a GitHub origin and a local origin/main.',
				rootLabel: 'Absolute path',
				rootPlaceholder: '/home/operator/code/product',
				rootGuidance: 'Any directory inside the repository works; Gateship registers its real top level.',
				containerGuidance: 'In Docker the path must exist inside the container, so mount the checkout first.',
				submit: 'Register project',
			},
			import: {
				title: 'Import a GitHub repository',
				description: 'Gateship clones the repository into a checkout it manages, and registers it once ready.',
				repositoryLabel: 'GitHub repository',
				repositoryPlaceholder: 'owner/repo or https://github.com/owner/repo',
				destinationGuidance: 'Gateship stores the clone under its own managed directory, not a path you choose.',
				credentialGuidance: 'A public repository needs nothing else; a private one uses your existing GitHub login. No token or password is ever entered here.',
				submit: 'Import repository',
				pending: 'Cloning the repository…',
			},
			create: {
				title: 'Create a new GitHub repository',
				description: 'Gateship creates the repository, an initial README commit on main, and its managed checkout.',
				repositoryLabel: 'GitHub repository',
				repositoryPlaceholder: 'owner/repo',
				descriptionLabel: 'Short description (optional)',
				descriptionPlaceholder: 'What this repository is for',
				visibilityLabel: 'Visibility',
				privateLabel: 'Private',
				publicLabel: 'Public',
				publicWarning: 'A public repository is visible to everyone on GitHub.',
				destinationGuidance: 'The checkout is stored under GATESHIP_HOME/projects/owner/repo. A custom path is not accepted.',
				credentialGuidance: 'Creation and push use your existing GitHub CLI login. No token or password is entered here.',
				confirm: (repository, visibility) => `Create ${repository} as a ${visibility} GitHub repository.`,
				submit: 'Create repository',
				pending: 'Creating the repository and pushing main…',
			},
			remove: {
				title: 'Remove this project from Gateship',
				description: 'Removal only drops the registration from this Gateship installation.',
				filesRemain:
					'Nothing is deleted: the checkout, its .gship state, worktrees, branches, runs, issues and its GitHub repository all stay on disk, and the project can be registered again later.',
				confirm: (name) => `Remove ${name} from the registry and keep every file it has.`,
				submit: 'Remove project',
			},
		},
		overview: {
			title: 'Operations overview', description: 'A live view of project readiness, active work and recent outcomes.', loading: 'Loading operational overview…', empty: 'No projects are registered yet.', partial: 'Some project data is unavailable.', error: 'The operational overview could not be loaded.',
			metrics: { activeProjects: 'Active projects', attention: 'Needs attention', backlog: 'Approved backlog', completed: 'Runs completed', cost: 'Known cost' }, activeRun: 'Active run', issue: 'Issue', phase: 'Phase', provider: 'Provider', updated: 'Updated', backlogLabel: 'Backlog', lastOutcome: 'Last outcome', noRun: 'No active run', noOutcome: 'No outcome in this window', databaseUnavailable: 'Operational data is unavailable.', historyUnavailable: 'Historical data is unavailable.', noCost: 'Unknown', costCoverage: (known, total) => `${known} of ${total} runs reported cost`, trend: 'Outcomes', activity: 'Activity', outcomes: { shipped: 'shipped', failed: 'failed', cancelled: 'cancelled', incomplete: 'incomplete' },
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
			correctionRounds: (executor, ci, decision, orchestrator, indeterminate) => {
				const total = executor + ci + decision + orchestrator + indeterminate;
				const parts = [
					`${executor} from the executor`,
					...(ci > 0 ? [`${ci} from CI correction`] : []),
					`${decision} from ${decision === 1 ? 'an operator decision' : 'operator decisions'}`,
					`${orchestrator} resolved by the orchestrator`,
				];
				if (indeterminate > 0) {
					parts.push(`${indeterminate} with indeterminate ${indeterminate === 1 ? 'origin' : 'origins'}`);
				}
				return `${total === 1 ? 'Correction round' : 'Correction rounds'}: ${parts.join(', ')}`;
			},
			pullRequestLabel: (number) => `PR #${number}`,
			ciCorrectionLabel: (checkName) => `CI correction: ${checkName}`,
			ciLabels: {
				'not-reported': 'CI not reported',
				pending: 'CI pending',
				passed: 'CI passed',
				failed: 'CI failed',
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
			executorHandoff: {
				accessibleLabel: 'Executor handoff',
				title: (fromProviderName, toProviderName) =>
					`Executor handed off from ${fromProviderName} to ${toProviderName}`,
				refusedTitle: (fromProviderName, toProviderName) =>
					`Executor handoff to ${toProviderName} was refused; the run stayed on ${fromProviderName}`,
				reasonPrefix: 'Reason: ',
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
				corrections: (roundCount, runCount, executor, ci, decision, orchestrator, indeterminate) =>
					`${roundCount} ${roundCount === 1 ? 'round' : 'rounds'} across ${runCount} ${runCount === 1 ? 'run' : 'runs'}: ${executor} automatic${ci === 0 ? '' : `, ${ci} from CI correction`}, ${orchestrator} orchestrator-resolved, ${decision} after ${decision === 1 ? 'a human decision' : 'human decisions'}${indeterminate === 0 ? '' : `, ${indeterminate} with indeterminate origin`}`,
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
				evidence: 'Evidence captured when specified',
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
		settings: {
			title: 'Settings',
			disclosure: { open: 'open', close: 'close' },
			project: { title: 'Project', description: 'The process operates one local project at a time; this binding is derived from Git, not hidden configuration.', stateLabels: { ready: 'ready', checking: 'checking', attention: 'attention' }, localProject: 'Local project', repository: 'Repository', runSource: 'Run source' },
			operator: { title: 'Operator', description: 'Human identity and timezone used as non-authoritative conversation context.', name: 'Name', namePlaceholder: 'What the orchestrator should call you', timezone: 'Timezone', timezonePlaceholder: 'America/Sao_Paulo', timezoneGuidance: 'IANA identifier. The browser suggestion is saved only when you confirm.', save: 'Save profile' },
			providers: {
				title: 'Local agents', description: 'Gateship uses subscriptions from installed clients. Claude can optionally use a dedicated credential of its own, isolated from Claude Desktop or the terminal; Codex and the external Claude login never leave the client that owns them.', inUse: 'in use',
				connectedUnavailable: (reason) => `Subscription connected, but currently unavailable: ${reason}.`, unavailable: (reason) => `Currently unavailable: ${reason}.`, connected: (plan) => `Subscription connected${plan === undefined ? '' : ` · ${plan}`}`, installedDisconnected: 'Installed, without a connected subscription', clientMissing: 'Client not found', connectChatGpt: 'Connect ChatGPT', useProvider: (label) => `Use ${label}`,
				codexSubscriptionGuidance: 'Recommended: sign in with your ChatGPT subscription using codex login in the environment where Gateship runs.',
				codexApiKeyWarning: 'An API key uses Platform billing, not credits from your ChatGPT plan, and is not an admissible subscription login for Gateship execution.',
				codexEnterpriseFuture: 'Codex Enterprise access-token support is planned for a future capability; it is not available here.',
				waitReasons: { 'auth-required': 'Authentication required', 'usage-limit': 'Subscription usage limit reached', 'rate-limited': 'Calls temporarily rate-limited', overloaded: 'Provider temporarily overloaded', 'model-refused': 'Model or effort rejected', 'transport-unavailable': 'Provider connection unavailable', 'protocol-invalid': 'Invalid provider response', cancelled: 'Call cancelled', unknown: 'Provider unavailable' },
				usageWindowLabels: { five_hour: '5 hour', seven_day: '7 day', seven_day_opus: '7 day (Opus)', seven_day_sonnet: '7 day (Sonnet)', seven_day_overage_included: '7 day (overage)', overage: 'Overage' },
				duration: { days: (_count, formatted) => `${formatted} day`, hours: (_count, formatted) => `${formatted} hour`, minutes: (formatted) => `${formatted} min` },
				usedPercent: (formatted) => `${formatted} used`, resets: 'resets', asOf: 'as of', credits: 'Credits', unlimited: 'unlimited', available: 'available', none: 'none', spendLimit: (used, limit, remainingPercent) => `Spend limit: ${used} of ${limit} (${remainingPercent} remaining)`, resetCredits: (_count, formatted) => `${formatted} reset credit(s) available`,
				claudeCredential: {
					recommendedTitle: 'Recommended: interactive Claude subscription login',
					recommendedGuidance: 'Sign in with your Claude subscription in the environment where Gateship runs. If Gateship runs in a container, run the command inside that container.',
					recommendedCommandLabel: 'Run this command in that environment:',
					usageGuidance: 'A setup token is limited to inference. It may not expose your account, organization or plan. Usage windows appear here only when the Claude CLI reports them during calls.',
					explanation: 'A dedicated subscription token keeps Gateship\'s own Claude access separate from Claude Desktop\'s or the terminal\'s login. Generate one on this host and paste it once below; it is never shown again.',
					inferenceOnly: 'Gateship checks the token with one minimal Claude call, without tools. A setup token is limited to inference, so Claude may report no email, organization or plan for it -- that is expected, not a failed connection.',
					cliMissing: 'Claude CLI not found. Install it before connecting a dedicated subscription.',
					setupCommandLabel: 'Run this command, then paste the printed token below:',
					copyCommand: 'Copy command',
					tokenLabel: 'Setup token',
					tokenPlaceholder: 'Paste the token from claude setup-token',
					confirm: 'I confirm this is the subscription I want Gateship to use.',
					connect: 'Connect',
					rotate: 'Rotate',
					cancel: 'Cancel',
					disconnect: 'Disconnect',
					connected: 'Dedicated subscription connected.',
					needsReconnect: 'Dedicated credential needs reconnecting.',
					envManaged: 'Managed by CLAUDE_CODE_OAUTH_TOKEN in the service environment. Connecting, rotating and disconnecting are unavailable here: change or remove that variable in the service configuration and restart Gateship.',
					advancedTitle: 'Advanced: use a dedicated setup token instead',
					originLabels: { external: 'external login', web: 'managed login', dedicated: 'dedicated credential' },
				},
			},
			models: { title: 'Model and effort by role', description: 'Applies to the next agent started, without restarting the service. An empty field keeps the CLI default. The field is free text: the CLI itself rejects an invalid value with its own error, not Gateship.', roleLabels: { orchestrator: 'Orchestrator', executor: 'Executor', reviewer: 'Reviewer' }, model: 'model', effort: 'effort', cliDefault: 'CLI default', documentation: (provider) => `${provider} models in the official documentation`, save: 'Save models' },
			chain: { title: 'Automatic run chaining', description: 'When a run finishes in done, starts the next approved issue automatically in ID order.', label: 'Chain approved runs automatically' },
			executorHandoff: {
				title: 'Executor handoff between providers',
				description: 'When the primary provider reports a subscription usage limit or a rate limit while implementing, transfers only the executor role to the other provider once for that run. Off by default; the run keeps its issue, worktree, branch, pull request, decisions and evidence, and the alternate opens its own new session.',
				label: 'Allow one executor handoff per run',
			},
			updates: { title: 'Gateship updates', description: 'Checks official releases at most daily and applies a verified native binary only while the project is idle.', label: 'Install verified native updates automatically', guidance: 'Fixed cadence: daily. Runs, preserved waiting states, diagnostics, containers, and source checkouts are never updated in place.', available: 'Available', unknown: 'unknown', statusLabels: { success: 'success', rollback: 'rollback', failed: 'failed', 'check-failed': 'check-failed', deferred: 'deferred' }, result: (previous, target, at) => `${previous} → ${target} at ${at}` },
			diagnostics: { title: 'Diagnostic schedule', description: 'Runs at most one overdue diagnostic, and only while this project is idle.', label: 'Run diagnostics periodically', cadence: 'Cadence', cadenceLabels: { daily: 'Daily', weekly: 'Weekly' }, disabled: 'Disabled.', overdue: 'overdue', nextRun: (value) => `Next run: ${value}`, calculating: 'calculating', guidance: 'A manual scan also resets the window. Missed periods do not create catch-up runs.', save: 'Save schedule' },
			notifications: {
				title: 'Notifications', description: 'The browser alerts you when a run needs you or finishes; remote channels alert you even when the tab is closed.', permissionStates: { granted: 'Active in this browser.', denied: "Blocked in this browser's permissions.", unsupported: 'Unavailable in this browser.', default: 'Permission not requested yet.' }, actionLabels: { granted: 'Notifications active', denied: 'Notifications blocked', unsupported: 'Notifications unavailable', default: 'Enable notifications' }, channelLabels: { ntfy: 'ntfy', resend: 'email (Resend)' }, configured: 'configured', notConfigured: 'not configured', missing: (values) => ` (missing: ${values})`, sendTest: 'Send test',
				resendFields: { from: 'Sender', to: 'Recipient', apiKey: 'Replacement API key (optional)' },
				resendPlaceholders: { from: 'Gateship <ops@example.com>', to: 'operator@example.com', apiKey: 'Blank keeps the current credential' },
				saveResend: 'Save Resend settings', removeResendCredential: 'Remove credential', externallyManaged: 'Managed by the environment', fileCredentialPresent: 'A file-backed credential is present.', fileCredentialAbsent: 'No file credential is present.',
				instructions: { ntfy: 'Save the topic URL in {file} with mode 600, or set {url}, which takes precedence over the file. ', resend: 'Settings saves non-secret sender and recipient locally and writes an optional replacement key to {file} with mode 600. {key}, {from}, and {to} each override the corresponding file value. ' },
				docLabels: { ntfy: 'ntfy documentation', resendApiKeys: 'Resend API keys', resendDomain: 'Resend domain verification' },
			},
			brief: { title: 'Project brief', description: 'Authoritative human context. Save it here or explicitly confirm a conversational update; a successful write clears the automatic handoff.', fieldLabels: { objective: 'Objective', decisions: 'Decisions', constraints: 'Constraints', openItems: 'Open items' }, linePlaceholder: 'One item per line', save: 'Save brief' },
			handoff: { title: 'Automatic handoff', description: 'Session state observed and generated by the orchestrator. A brief write clears it; a later parsed turn may rebuild it.', readOnly: 'read-only', rewritten: 'Rewritten after each successfully parsed orchestrator turn.', nothingRecorded: 'Nothing recorded yet.' },
		},
		onboarding: {
			title: 'Set up project',
			cardTitle: 'Connect a GitHub project',
			description: 'Gateship runs inside a local clone and uses origin/main as its deterministic source.',
			existingProject: { title: 'Existing project', guidance: 'Stop this process and start Gateship inside the clone.' },
			newProject: { title: 'New project', guidance: 'Create the repository with a main branch, enter the clone and start Gateship.' },
			incompleteBadge: 'incomplete configuration',
			recoveryGuidance: 'After correcting it, restart Gateship. In a container, update GATESHIP_PROJECT_DIR and recreate the service.',
			settingsGuidance: { beforeLink: 'Agent and subscription settings remain available under ', linkLabel: 'Settings', afterLink: '.' },
		},
	},
	'pt-BR': {
		shell: {
			operatorNavigationLabel: 'Superfícies do operador',
			projectNavigationLabel: 'Projetos',
			allProjectsLabel: 'Todos os projetos',
			skipLinkLabel: 'Pular para o conteúdo',
			languageLabel: 'Idioma',
			routeLabels: {
				conversation: 'Conversa',
				runs: 'Runs',
				work: 'Trabalho',
				settings: 'Ajustes',
				globalSettings: 'Ajustes globais',
			},
		},
		projects: {
			title: 'Todos os projetos',
			description: 'Projetos registrados disponíveis nesta instalação do Gateship.',
			currentBadge: 'servido por esta instância',
			repositoryUnknown: 'Repositório desconhecido',
			readinessLabel: 'Prontidão',
			readiness: { ready: 'pronto', empty: 'vazio', 'needs-attention': 'requer atenção' },
			unavailableTitle: 'Runtime do projeto não carregado',
			unavailableDescription: 'Este projeto está registrado, mas seu runtime não está carregado nesta instância do Gateship.',
			notFoundTitle: 'Projeto não registrado',
			notFoundDescription: 'Esta URL não corresponde a um projeto registrado.',
			register: {
				title: 'Registrar um checkout existente',
				description: 'O Gateship só registra um clone que já tem origin no GitHub e origin/main local.',
				rootLabel: 'Caminho absoluto',
				rootPlaceholder: '/home/operador/code/produto',
				rootGuidance: 'Qualquer diretório dentro do repositório serve; o Gateship registra o top-level real.',
				containerGuidance: 'No Docker o caminho precisa existir dentro do contêiner, então monte o checkout antes.',
				submit: 'Registrar projeto',
			},
			import: {
				title: 'Importar um repositório do GitHub',
				description: 'O Gateship clona o repositório em um checkout que ele mesmo gerencia, e o registra assim que estiver pronto.',
				repositoryLabel: 'Repositório do GitHub',
				repositoryPlaceholder: 'owner/repo ou https://github.com/owner/repo',
				destinationGuidance: 'O Gateship guarda o clone no seu próprio diretório gerenciado, não em um caminho à sua escolha.',
				credentialGuidance: 'Um repositório público não precisa de mais nada; um privado usa o seu login do GitHub já existente. Nenhum token ou senha é digitado aqui.',
				submit: 'Importar repositório',
				pending: 'Clonando o repositório…',
			},
			create: {
				title: 'Criar um repositório novo no GitHub',
				description: 'O Gateship cria o repositório, um commit inicial com README na main e seu checkout gerenciado.',
				repositoryLabel: 'Repositório do GitHub',
				repositoryPlaceholder: 'owner/repo',
				descriptionLabel: 'Descrição curta (opcional)',
				descriptionPlaceholder: 'Para que serve este repositório',
				visibilityLabel: 'Visibilidade',
				privateLabel: 'Privado',
				publicLabel: 'Público',
				publicWarning: 'Um repositório público fica visível para qualquer pessoa no GitHub.',
				destinationGuidance: 'O checkout fica em GATESHIP_HOME/projects/owner/repo. Não é aceito um caminho personalizado.',
				credentialGuidance: 'A criação e o push usam seu login existente no GitHub CLI. Nenhum token ou senha é digitado aqui.',
				confirm: (repository, visibility) => `Criar ${repository} como um repositório ${visibility} no GitHub.`,
				submit: 'Criar repositório',
				pending: 'Criando o repositório e enviando a main…',
			},
			remove: {
				title: 'Remover este projeto do Gateship',
				description: 'A remoção só tira o registro desta instalação do Gateship.',
				filesRemain:
					'Nada é apagado: o checkout, o estado em .gship, worktrees, branches, runs, issues e o repositório no GitHub continuam no disco, e o projeto pode ser registrado de novo depois.',
				confirm: (name) => `Remover ${name} do registro e manter todos os seus arquivos.`,
				submit: 'Remover projeto',
			},
		},
		overview: {
			title: 'Central de operações', description: 'Visão ao vivo da prontidão, do trabalho ativo e dos resultados recentes dos projetos.', loading: 'Carregando visão operacional…', empty: 'Nenhum projeto foi registrado ainda.', partial: 'Alguns dados de projetos estão indisponíveis.', error: 'Não foi possível carregar a visão operacional.',
			metrics: { activeProjects: 'Projetos ativos', attention: 'Requer atenção', backlog: 'Backlog aprovado', completed: 'Runs concluídas', cost: 'Custo conhecido' }, activeRun: 'Run ativa', issue: 'Issue', phase: 'Fase', provider: 'Provider', updated: 'Atualizado', backlogLabel: 'Backlog', lastOutcome: 'Último resultado', noRun: 'Nenhuma run ativa', noOutcome: 'Nenhum resultado nesta janela', databaseUnavailable: 'Dados operacionais indisponíveis.', historyUnavailable: 'Dados históricos indisponíveis.', noCost: 'Desconhecido', costCoverage: (known, total) => `${known} de ${total} runs informaram custo`, trend: 'Resultados', activity: 'Atividade', outcomes: { shipped: 'enviada', failed: 'falhou', cancelled: 'cancelada', incomplete: 'incompleta' },
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
			correctionRounds: (executor, ci, decision, orchestrator, indeterminate) => {
				const total = executor + ci + decision + orchestrator + indeterminate;
				const parts = [
					`${executor} do executor`,
					...(ci > 0 ? [`${ci} de Correção de CI`] : []),
					`${decision} ${decision === 1 ? 'de uma decisão do operador' : 'de decisões do operador'}`,
					`${orchestrator} resolvida${orchestrator === 1 ? '' : 's'} pelo orquestrador`,
				];
				if (indeterminate > 0) {
					parts.push(`${indeterminate} ${indeterminate === 1 ? 'indeterminada' : 'indeterminadas'}`);
				}
				return `${total === 1 ? 'Rodada de correção' : 'Rodadas de correção'}: ${parts.join(', ')}`;
			},
			pullRequestLabel: (number) => `PR #${number}`,
			ciCorrectionLabel: (checkName) => `Correção de CI: ${checkName}`,
			ciLabels: {
				'not-reported': 'CI não informada',
				pending: 'CI pendente',
				passed: 'CI aprovada',
				failed: 'CI com falha',
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
			executorHandoff: {
				accessibleLabel: 'Transferência de executor',
				title: (fromProviderName, toProviderName) =>
					`Executor transferido de ${fromProviderName} para ${toProviderName}`,
				refusedTitle: (fromProviderName, toProviderName) =>
					`Transferência de executor para ${toProviderName} foi recusada; a execução permaneceu em ${fromProviderName}`,
				reasonPrefix: 'Motivo: ',
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
				corrections: (roundCount, runCount, executor, ci, decision, orchestrator, indeterminate) =>
					`${roundCount} ${roundCount === 1 ? 'rodada' : 'rodadas'} em ${runCount} ${runCount === 1 ? 'execução' : 'execuções'}: ${executor} automática${executor === 1 ? '' : 's'}${ci === 0 ? '' : `, ${ci} de Correção de CI`}, ${orchestrator} resolvida${orchestrator === 1 ? '' : 's'} pelo orquestrador, ${decision} após ${decision === 1 ? 'uma decisão humana' : 'decisões humanas'}${indeterminate === 0 ? '' : `, ${indeterminate} de origem indeterminada`}`,
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
				evidence: 'Evidências capturadas ao especificar',
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
		settings: {
			title: 'Ajustes',
			disclosure: { open: 'abrir', close: 'fechar' },
			project: { title: 'Projeto', description: 'O processo opera um projeto local por vez; este vínculo é derivado do Git, não de uma configuração oculta.', stateLabels: { ready: 'pronto', checking: 'verificando', attention: 'atenção' }, localProject: 'Projeto local', repository: 'Repositório', runSource: 'Origem das execuções' },
			operator: { title: 'Operador', description: 'Identidade humana e fuso horário usados como contexto não autoritativo da conversa.', name: 'Nome', namePlaceholder: 'Como o orquestrador deve chamar você', timezone: 'Fuso horário', timezonePlaceholder: 'America/Sao_Paulo', timezoneGuidance: 'Identificador IANA. A sugestão do navegador só é salva quando você confirma.', save: 'Salvar perfil' },
			providers: {
				title: 'Agentes locais', description: 'O Gateship usa assinaturas de clientes instalados. O Claude pode opcionalmente usar uma credencial dedicada própria, isolada do Claude Desktop ou do terminal; o Codex e o login externo do Claude nunca saem do cliente que os possui.', inUse: 'em uso',
				connectedUnavailable: (reason) => `Assinatura conectada, mas indisponível no momento: ${reason}.`, unavailable: (reason) => `Indisponível no momento: ${reason}.`, connected: (plan) => `Assinatura conectada${plan === undefined ? '' : ` · ${plan}`}`, installedDisconnected: 'Instalado, sem uma assinatura conectada', clientMissing: 'Cliente não encontrado', connectChatGpt: 'Conectar ChatGPT', useProvider: (label) => `Usar ${label}`,
				codexSubscriptionGuidance: 'Recomendado: entre com sua assinatura do ChatGPT usando codex login no ambiente onde o Gateship executa.',
				codexApiKeyWarning: 'Uma API key usa o faturamento da Platform, não os créditos do seu plano ChatGPT, e não é um login de assinatura admissível para execução no Gateship.',
				codexEnterpriseFuture: 'O suporte a access token do Codex Enterprise é uma capacidade futura; não está disponível aqui.',
				waitReasons: { 'auth-required': 'Autenticação necessária', 'usage-limit': 'Limite de uso da assinatura atingido', 'rate-limited': 'Chamadas temporariamente limitadas', overloaded: 'Provedor temporariamente sobrecarregado', 'model-refused': 'Modelo ou esforço rejeitado', 'transport-unavailable': 'Conexão com o provedor indisponível', 'protocol-invalid': 'Resposta inválida do provedor', cancelled: 'Chamada cancelada', unknown: 'Provedor indisponível' },
				usageWindowLabels: { five_hour: '5 horas', seven_day: '7 dias', seven_day_opus: '7 dias (Opus)', seven_day_sonnet: '7 dias (Sonnet)', seven_day_overage_included: '7 dias (excedente)', overage: 'Excedente' },
				duration: { days: (count, formatted) => `${formatted} ${count === 1 ? 'dia' : 'dias'}`, hours: (count, formatted) => `${formatted} ${count === 1 ? 'hora' : 'horas'}`, minutes: (formatted) => `${formatted} min` },
				usedPercent: (formatted) => `${formatted} usados`, resets: 'reinicia', asOf: 'observado em', credits: 'Créditos', unlimited: 'ilimitados', available: 'disponíveis', none: 'nenhum', spendLimit: (used, limit, remainingPercent) => `Limite de gastos: ${used} de ${limit} (${remainingPercent} restantes)`, resetCredits: (count, formatted) => `${formatted} ${count === 1 ? 'crédito de reinício disponível' : 'créditos de reinício disponíveis'}`,
				claudeCredential: {
					recommendedTitle: 'Recomendado: login interativo da assinatura Claude',
					recommendedGuidance: 'Entre com sua assinatura Claude no ambiente onde o Gateship executa. Se o Gateship estiver em um container, execute o comando dentro dele.',
					recommendedCommandLabel: 'Execute este comando nesse ambiente:',
					usageGuidance: 'Um token de configuração é limitado a inferência. Ele pode não expor sua conta, organização ou plano. As janelas de uso só aparecem aqui quando a CLI do Claude as reporta durante chamadas.',
					explanation: 'Um token de assinatura dedicado mantém o acesso do Gateship ao Claude separado do login do Claude Desktop ou do terminal. Gere um neste host e cole-o uma única vez abaixo; ele não é mostrado novamente.',
					inferenceOnly: 'O Gateship verifica o token com uma chamada mínima ao Claude, sem ferramentas. Um token de configuração é limitado a inferência, então o Claude pode não informar e-mail, organização ou plano para ele -- isso é esperado, não uma conexão que falhou.',
					cliMissing: 'Claude CLI não encontrado. Instale-o antes de conectar uma assinatura dedicada.',
					setupCommandLabel: 'Execute este comando e cole o token impresso abaixo:',
					copyCommand: 'Copiar comando',
					tokenLabel: 'Token de configuração',
					tokenPlaceholder: 'Cole o token de claude setup-token',
					confirm: 'Confirmo que esta é a assinatura que quero que o Gateship use.',
					connect: 'Conectar',
					rotate: 'Rotacionar',
					cancel: 'Cancelar',
					disconnect: 'Desconectar',
					connected: 'Assinatura dedicada conectada.',
					needsReconnect: 'A credencial dedicada precisa ser reconectada.',
					envManaged: 'Gerenciado por CLAUDE_CODE_OAUTH_TOKEN no ambiente do serviço. Conectar, rotacionar e desconectar não estão disponíveis aqui: altere ou remova essa variável na configuração do serviço e reinicie o Gateship.',
					advancedTitle: 'Avançado: usar um token de configuração dedicado',
					originLabels: { external: 'login externo', web: 'login gerenciado', dedicated: 'credencial dedicada' },
				},
			},
			models: { title: 'Modelo e esforço por função', description: 'Aplica-se ao próximo agente iniciado, sem reiniciar o serviço. Um campo vazio mantém o padrão da CLI. O campo é texto livre: a própria CLI rejeita um valor inválido com seu próprio erro, não o Gateship.', roleLabels: { orchestrator: 'Orquestrador', executor: 'Executor', reviewer: 'Revisor' }, model: 'modelo', effort: 'esforço', cliDefault: 'Padrão da CLI', documentation: (provider) => `Modelos do ${provider} na documentação oficial`, save: 'Salvar modelos' },
			chain: { title: 'Encadeamento automático de execuções', description: 'Quando uma execução termina como concluída, inicia automaticamente a próxima issue aprovada em ordem de ID.', label: 'Encadear execuções aprovadas automaticamente' },
			executorHandoff: {
				title: 'Transferência de executor entre provedores',
				description: 'Quando o provedor primário reporta limite de uso da assinatura ou limite de taxa durante a implementação, transfere apenas o papel executor para o outro provedor, uma única vez por execução. Desabilitado por padrão; a execução preserva issue, worktree, branch, pull request, decisões e evidências, e o provedor alternativo abre sua própria sessão nova.',
				label: 'Permitir uma transferência de executor por execução',
			},
			updates: { title: 'Atualizações do Gateship', description: 'Verifica lançamentos oficiais no máximo uma vez por dia e aplica um binário nativo verificado somente enquanto o projeto está ocioso.', label: 'Instalar atualizações nativas verificadas automaticamente', guidance: 'Cadência fixa: diária. Execuções, estados de espera preservados, diagnósticos, contêineres e checkouts de código-fonte nunca são atualizados no lugar.', available: 'Disponível', unknown: 'desconhecida', statusLabels: { success: 'sucesso', rollback: 'reversão', failed: 'falhou', 'check-failed': 'verificação falhou', deferred: 'adiada' }, result: (previous, target, at) => `${previous} → ${target} em ${at}` },
			diagnostics: { title: 'Agenda de diagnósticos', description: 'Executa no máximo um diagnóstico atrasado e somente enquanto este projeto está ocioso.', label: 'Executar diagnósticos periodicamente', cadence: 'Cadência', cadenceLabels: { daily: 'Diária', weekly: 'Semanal' }, disabled: 'Desativada.', overdue: 'atrasado', nextRun: (value) => `Próxima execução: ${value}`, calculating: 'calculando', guidance: 'Uma análise manual também reinicia a janela. Períodos perdidos não criam execuções de compensação.', save: 'Salvar agenda' },
			notifications: {
				title: 'Notificações', description: 'O navegador avisa quando uma execução precisa de você ou termina; canais remotos avisam mesmo com a aba fechada.', permissionStates: { granted: 'Ativas neste navegador.', denied: 'Bloqueadas nas permissões deste navegador.', unsupported: 'Indisponíveis neste navegador.', default: 'Permissão ainda não solicitada.' }, actionLabels: { granted: 'Notificações ativas', denied: 'Notificações bloqueadas', unsupported: 'Notificações indisponíveis', default: 'Ativar notificações' }, channelLabels: { ntfy: 'ntfy', resend: 'email (Resend)' }, configured: 'configurado', notConfigured: 'não configurado', missing: (values) => ` (faltando: ${values})`, sendTest: 'Enviar teste',
				resendFields: { from: 'Remetente', to: 'Destinatário', apiKey: 'Chave de API substituta (opcional)' },
				resendPlaceholders: { from: 'Gateship <ops@example.com>', to: 'operador@example.com', apiKey: 'Em branco mantém a credencial atual' },
				saveResend: 'Salvar configurações do Resend', removeResendCredential: 'Remover credencial', externallyManaged: 'Gerenciado pelo ambiente', fileCredentialPresent: 'Há uma credencial armazenada em arquivo.', fileCredentialAbsent: 'Não há credencial em arquivo.',
				instructions: { ntfy: 'Salve a URL do tópico em {file} com modo 600 ou defina {url}, que tem precedência sobre o arquivo. ', resend: 'As Configurações salvam localmente o remetente e destinatário não secretos e gravam uma chave substituta opcional em {file} com modo 600. {key}, {from} e {to} substituem individualmente o valor correspondente do arquivo. ' },
				docLabels: { ntfy: 'documentação do ntfy', resendApiKeys: 'chaves de API do Resend', resendDomain: 'verificação de domínio do Resend' },
			},
			brief: { title: 'Brief do projeto', description: 'Contexto humano autoritativo. Salve-o aqui ou confirme explicitamente uma atualização na conversa; uma gravação bem-sucedida limpa o handoff automático.', fieldLabels: { objective: 'Objetivo', decisions: 'Decisões', constraints: 'Restrições', openItems: 'Itens em aberto' }, linePlaceholder: 'Um item por linha', save: 'Salvar brief' },
			handoff: { title: 'Handoff automático', description: 'Estado da sessão observado e gerado pelo orquestrador. Uma gravação do brief o limpa; um turno posterior analisado com sucesso pode recriá-lo.', readOnly: 'somente leitura', rewritten: 'Reescrito após cada turno do orquestrador analisado com sucesso.', nothingRecorded: 'Nada registrado ainda.' },
		},
		onboarding: {
			title: 'Configurar projeto',
			cardTitle: 'Conectar um projeto do GitHub',
			description: 'O Gateship é executado dentro de um clone local e usa origin/main como sua origem determinística.',
			existingProject: { title: 'Projeto existente', guidance: 'Pare este processo e inicie o Gateship dentro do clone.' },
			newProject: { title: 'Novo projeto', guidance: 'Crie o repositório com uma branch main, entre no clone e inicie o Gateship.' },
			incompleteBadge: 'configuração incompleta',
			recoveryGuidance: 'Depois de corrigir, reinicie o Gateship. Em um contêiner, atualize GATESHIP_PROJECT_DIR e recrie o serviço.',
			settingsGuidance: { beforeLink: 'Os ajustes de agentes e assinaturas continuam disponíveis em ', linkLabel: 'Ajustes', afterLink: '.' },
		},
	},
} as const satisfies Record<Locale, LocaleCatalog>;
