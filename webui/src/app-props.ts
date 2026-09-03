import type {
	ChainRunsView,
	AgentDefaultsView,
	AgentSettingSource,
	ChatMessageView,
	CreateProjectInput,
	DiagnosticCadenceView,
	DiagnosticsView,
	ExecutorHandoffSettingView,
	GitIdentityView,
	IssueReviewDraft,
	ModelSettingsView,
	NotificationChannelId,
	NotificationChannelsView,
	OperatorIssueDraft,
	OperatorProfileView,
	OperatorSpecDraft,
	ProjectBriefView,
	ProjectOperationalOverviewView,
	ProjectStatusView,
	ProposalView,
	ProviderStatusView,
	RegisteredProjectView,
	ResolvedProposalView,
	SelfUpdateView,
	StaleServiceView,
	WorkspaceNoticeView,
} from './client.ts';
import type { Locale } from './locale.ts';
import type { BrowserNotificationPermission } from './notifications.ts';
import type { OperatorRoute } from './routes.ts';
import type { PlannableIssue, RunEventView, RunView } from './run-view.ts';
import type { OperationalFailures, OperationalLoaded } from './operational-snapshot.ts';

/** Complete pure-render contract for the operator application. */
export interface AppProps {
	operationalBoundary?: { state: 'loading' } | { state: 'failure'; detail: string; onRetry: () => void };
	operationalRefreshFailure?: { detail: string; onRetry: () => void };
	operationalFailures?: OperationalFailures;
	operationalLoaded?: OperationalLoaded;
	onNavigate?: (destination: string) => void;
	route: OperatorRoute;
	surfaceRoute?: OperatorRoute;
	locale: Locale;
	backlog: readonly PlannableIssue[];
	ideas: readonly PlannableIssue[];
	drafts: readonly IssueReviewDraft[];
	proposals: readonly ProposalView[];
	diagnostics: DiagnosticsView;
	resolvedProposals: readonly ResolvedProposalView[];
	resolvedProposalsOmittedCount: number;
	events: readonly RunEventView[];
	workspaceNotices: readonly WorkspaceNoticeView[];
	providers: readonly ProviderStatusView[];
	chatMessages: readonly ChatMessageView[];
	brief: ProjectBriefView;
	project: ProjectStatusView;
	projects: readonly RegisteredProjectView[];
	overview?: ProjectOperationalOverviewView | null;
	overviewLoading?: boolean;
	overviewError?: string | null;
	operatorProfile: OperatorProfileView;
	suggestedTimezone: string;
	handoff: ProjectBriefView;
	modelSettings: ModelSettingsView;
	modelSettingsSource: AgentSettingSource;
	agentDefaults: AgentDefaultsView;
	chainRuns: ChainRunsView;
	executorHandoff: ExecutorHandoffSettingView;
	selectedProvider: ProviderStatusView['id'];
	providerSource: AgentSettingSource;
	notificationPermission: BrowserNotificationPermission;
	notificationChannels: NotificationChannelsView;
	selfUpdate: SelfUpdateView;
	runs: readonly RunView[];
	selectedIssueId: string | null;
	version: string;
	staleService: StaleServiceView | null;
	gitIdentity: GitIdentityView | null;
	status: string | null;
	pending: boolean;
	projectOnboardingPending: 'create' | 'import' | null;
	claudeCredentialError: string | null;
	onSelectIssue: (issueId: string) => void;
	onSelectLocale: (locale: Locale) => void;
	onCreateIssue: (input: OperatorIssueDraft) => void;
	onSpecifyIssue: (issueId: string, input: OperatorSpecDraft) => void;
	onReviewIssue: (issueId: string, input: OperatorSpecDraft) => void;
	onApproveIssue: (issueId: string) => void;
	onAbandonIssue: (issueId: string, reason: string) => void;
	onDismissProposal: (proposalId: string) => void;
	onPromoteProposal: (proposalId: string, input: OperatorIssueDraft) => void;
	onStartDiagnostic: (analyzer: string) => void;
	onCancelDiagnostic: (scanId: string) => void;
	onDismissDiagnosticFinding: (findingId: string) => void;
	onPromoteDiagnosticFinding: (findingId: string, input: OperatorIssueDraft) => void;
	onSaveDiagnosticSchedule: (enabled: boolean, cadence: DiagnosticCadenceView) => void;
	onStart: () => void;
	onResume: (operatorGuidance?: string) => void;
	onAbandon: () => void;
	onCancel: () => void;
	onShip: () => void;
	onConnectCodex: () => void;
	onConnectClaudeCredential: (token: string) => Promise<boolean>;
	onDismissClaudeCredentialError: () => void;
	onDisconnectClaudeCredential: () => void;
	onEnableNotifications: () => void;
	onSendNotificationTest: (channelId: NotificationChannelId) => void;
	onSaveResendSettings: (input: { from: string; to: string; apiKey: string }) => void;
	onRemoveResendCredential: () => void;
	onSelectProvider: (providerId: ProviderStatusView['id']) => void;
	onResetProvider: () => void;
	onSendMessage: (message: string) => void;
	onSaveBrief: (brief: ProjectBriefView) => void;
	onSaveModelSettings: (settings: ModelSettingsView) => void;
	onResetModelSettings: () => void;
	onSaveAgentDefaults: (defaults: AgentDefaultsView) => void;
	onSaveOperatorProfile: (profile: OperatorProfileView) => void;
	onSetChainRuns: (enabled: boolean) => void;
	onSetExecutorHandoff: (enabled: boolean) => void;
	onSetSelfUpdate: (enabled: boolean) => void;
	onImportProject: (repository: string) => void;
	onCreateProject: (input: CreateProjectInput) => void;
	onRegisterProject: (root: string) => void;
	onUnregisterProject: (projectId: string) => void;
}
