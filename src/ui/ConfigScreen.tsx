// src/ui/ConfigScreen.tsx
//
// Tabbed UI for cam model configuration (US-004, CAM-241/153).
//
// 7 tabs, navigable via TabBar (Left/Right always switches tabs): the 6
// phases (orchestrator, planner, auditor, implementer, reviewer, ship) plus
// one Global tab. Each of the 5 LLM-phase tabs renders a model Select AND a
// NEW effort Select; the Ship tab renders the model Select only (ship is
// deterministic/zero-LLM, ADR-0009, so it has no effort concept). The Global
// tab folds backend/merge-mode/plan-approval plus the notify recipient/from
// text inputs.
//
// Within a tab, Up/Down navigates the options of whichever field is
// currently focused (only one Select/TextInput per tab is interactive at a
// time; the rest render their current-or-default value as a static "✓ ..."
// line via Select's own `confirmed`/`confirmedValue` props). Tab/Enter
// advances focus model -> effort -> next tab (see `computeNextFocus`);
// reaching past the last field of the last tab (Global's notify-from) fires
// onDone. This replaces the old sequential forward-only wizard: every tab and
// every field is reachable at any time via Left/Right, not gated on prior
// steps being answered.
//
// Success/failure is always signalled by the glyph (✓/✗), never by divider
// color (patterns.md: "Ink screens: success/failure is the glyph, not divider
// color").

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

import { colors } from './theme.ts';
import { Section } from './Section.tsx';
import { Select, type SelectOption } from './Select.tsx';
import { TabBar, type TabDef } from './TabBar.tsx';
import { DEFAULTS, EFFORT_DEFAULTS } from '../config/models.ts';
import type { Phase, LlmPhase, MergeMode, PlanApproval } from '../config/models.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConfigChoices = {
	models: Record<Phase, string>;
	backend: string;
	mergeMode?: MergeMode;
	planApproval?: PlanApproval;
	/** resend_recipient for [notify]. Empty string means "leave unset". */
	resendRecipient?: string;
	/** resend_from for [notify]. Empty string means "leave unset". */
	resendFrom?: string;
	/**
	 * Per-LLM-phase effort level (`ship` omitted: it has no effort setting,
	 * ADR-0009). Undefined means the wizard did not collect effort choices.
	 */
	efforts?: Record<LlmPhase, string>;
};

/** A tab is one of the 6 phases, or the Global tab. */
type TabKind = Phase | 'global';

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

const PHASE_STEPS: readonly Phase[] = [
	'orchestrator',
	'planner',
	'auditor',
	'implementer',
	'reviewer',
	'ship',
];

const LLM_PHASES: readonly LlmPhase[] = ['orchestrator', 'planner', 'auditor', 'implementer', 'reviewer'];

const PHASE_LABELS: Record<Phase, string> = {
	orchestrator: 'Orchestrator',
	planner: 'Planner',
	auditor: 'Auditor',
	implementer: 'Implementer',
	reviewer: 'Reviewer',
	ship: 'Ship',
};

const TABS: readonly TabKind[] = [...PHASE_STEPS, 'global'];

// CLI tier aliases (ADR-0034, code.claude.com/docs/en/model-config): each
// alias auto-resolves to the current latest model of its tier at spawn time,
// so this list never goes stale and needs no detection code. Trade-off: an
// alias is recommended and always-current, but not reproducible; to pin a
// reproducible snapshot instead, edit `[models]` in project.toml directly with
// a dated id (e.g. `claude-opus-4-8`) rather than picking it here.
export const MODEL_OPTIONS: readonly SelectOption<string>[] = [
	{ value: 'opus', label: 'opus', description: 'Auto-tracks the latest Opus for complex reasoning (recommended, always-current)' },
	{ value: 'sonnet', label: 'sonnet', description: 'Auto-tracks the latest Sonnet for daily coding tasks (recommended, always-current)' },
	{ value: 'haiku', label: 'haiku', description: 'Auto-tracks the latest Haiku, fast and economical (recommended, always-current)' },
	{ value: 'default', label: 'default', description: 'Tier-aware: resolves to the recommended model for your account/subscription (varies by plan)' },
	{ value: 'fable', label: 'fable', description: 'Auto-tracks Fable, for the hardest and longest-running tasks' },
	{ value: 'opusplan', label: 'opusplan', description: 'Hybrid: opus during plan mode, then switches to sonnet for execution' },
	{ value: 'sonnet[1m]', label: 'sonnet[1m]', description: 'Sonnet with the 1M-token context window for long sessions' },
	{ value: 'opus[1m]', label: 'opus[1m]', description: 'Opus with the 1M-token context window for long sessions' },
];

// Sentinel picked by the operator to reveal a free-text input (below) instead
// of picking a fixed alias. Never written to project.toml verbatim: the text
// typed into the follow-up TextInput is what gets stored.
const CUSTOM_MODEL_VALUE = '__custom__';

const CUSTOM_MODEL_OPTION: SelectOption<string> = {
	value: CUSTOM_MODEL_VALUE,
	label: 'custom / enter id',
	description: 'Type an arbitrary model id (e.g. a pinned dated snapshot, or an unreleased/preview id)',
};

// Per-phase picker options: every alias plus the free-text passthrough.
const PHASE_MODEL_OPTIONS: readonly SelectOption<string>[] = [...MODEL_OPTIONS, CUSTOM_MODEL_OPTION];

// AC4: exactly 5 effort tiers, in order.
const EFFORT_OPTIONS: readonly SelectOption<string>[] = [
	{ value: 'low', label: 'low' },
	{ value: 'medium', label: 'medium' },
	{ value: 'high', label: 'high' },
	{ value: 'xhigh', label: 'xhigh' },
	{ value: 'max', label: 'max' },
];

// AC4: backend options — codex carries the literal label 'wired in CAM-54'.
const BACKEND_OPTIONS: readonly SelectOption<string>[] = [
	{ value: 'claude', label: 'claude', description: 'Default Claude Code backend' },
	{ value: 'codex', label: 'codex', description: 'wired in CAM-54' },
];

const MERGE_MODE_OPTIONS: readonly SelectOption<MergeMode>[] = [
	{ value: 'immediate', label: 'Immediate (default)', description: 'Merge PR as soon as it is created' },
	{ value: 'ci-gated', label: 'CI-gated', description: 'Wait for CI to pass before merging' },
];

const PLAN_APPROVAL_OPTIONS: readonly SelectOption<PlanApproval>[] = [
	{ value: 'auto', label: 'Auto (default)', description: 'Sidecar advances automatically after plan audit' },
	{ value: 'operator', label: 'Operator gate', description: 'Pause for human approval before each loop' },
];

// ---------------------------------------------------------------------------
// Focus-advance chain (AC5): a pure, unit-testable helper
// ---------------------------------------------------------------------------

interface FocusState {
	activeTab: number;
	fieldFocus: number;
}

/** Field count per tab kind: 2 for an LLM phase (model, effort), 1 for Ship
 * (model only), 5 for Global (backend, merge-mode, plan-approval, notify
 * recipient, notify from). */
function fieldCountForTab(tab: TabKind): number {
	if (tab === 'global') return 5;
	if (tab === 'ship') return 1;
	return 2;
}

/**
 * Pure focus-advance step: model -> effort -> next tab (AC5). Returns 'done'
 * when advancing past the last field of the last tab (Global's notify-from),
 * which the caller treats as "submit". Extracted from the component so the
 * Tab/Enter chain stays unit-testable without mounting Ink, and to keep
 * ConfigScreen's cognitive complexity under budget.
 */
export function computeNextFocus(state: FocusState): FocusState | 'done' {
	const tab = TABS[state.activeTab] ?? 'global';
	const count = fieldCountForTab(tab);
	if (state.fieldFocus + 1 < count) {
		return { activeTab: state.activeTab, fieldFocus: state.fieldFocus + 1 };
	}
	if (state.activeTab + 1 >= TABS.length) {
		return 'done';
	}
	return { activeTab: state.activeTab + 1, fieldFocus: 0 };
}

/** Exported for direct unit testing (avoids asserting on wrapped/wide Ink
 * frames, where a chip's "Label: value" text can be split across a
 * terminal-width line-wrap). */
export function buildTabDefs(models: Partial<Record<Phase, string>>): TabDef[] {
	return TABS.map((tab) =>
		tab === 'global'
			? { label: 'Global' }
			: { label: PHASE_LABELS[tab], confirmed: true, value: models[tab] ?? DEFAULTS[tab] },
	);
}

// ---------------------------------------------------------------------------
// ConfigScreen component
// ---------------------------------------------------------------------------

interface ConfigScreenProps {
	onDone: (choices: ConfigChoices) => void;
	onCancel: () => void;
}

/**
 * Encapsulates the 'custom / enter id' picker sentinel: which phase (if any)
 * is currently showing the free-text input instead of the Select list, the
 * in-progress draft, and the transitions in/out of that mode. `commit` is the
 * caller's "store this phase's model + advance focus" callback, shared with
 * the normal alias-select path so both paths land in the same place.
 */
function useCustomModelEntry(commit: (phase: Phase, value: string) => void) {
	const [phase, setPhase] = useState<Phase | null>(null);
	const [draft, setDraft] = useState('');

	// Esc backs out to the Select list (TextInput itself only reports typing +
	// Enter via onSubmit; mirrors SetupScreen's separate useInput for escape).
	useInput(
		(_input, key) => {
			if (key.escape) setPhase(null);
		},
		{ isActive: phase !== null },
	);

	function select(p: Phase, value: string): boolean {
		if (value !== CUSTOM_MODEL_VALUE) return false;
		setDraft('');
		setPhase(p);
		return true;
	}

	function submit(p: Phase, value: string): void {
		const trimmed = value.trim();
		if (trimmed === '') return;
		commit(p, trimmed);
		setPhase(null);
	}

	return { phase, draft, setDraft, select, submit };
}

/**
 * All ConfigScreen state (7-tab focus position, per-field values, the custom-
 * model-entry sub-state) plus the commit/advance handlers, bundled into one
 * hook so the component body itself stays under the lint line-count budget.
 */
function useConfigScreenState(onDone: (choices: ConfigChoices) => void) {
	const [activeTab, setActiveTab] = useState(0);
	const [fieldFocus, setFieldFocus] = useState(0);
	const [models, setModels] = useState<Partial<Record<Phase, string>>>({});
	const [efforts, setEfforts] = useState<Partial<Record<LlmPhase, string>>>({});
	const [backend, setBackend] = useState<string | undefined>(undefined);
	const [mergeMode, setMergeMode] = useState<MergeMode | undefined>(undefined);
	const [planApproval, setPlanApproval] = useState<PlanApproval | undefined>(undefined);
	const [resendRecipient, setResendRecipient] = useState('');
	const [resendFrom, setResendFrom] = useState('');
	const [done, setDone] = useState(false);

	function changeTab(next: number): void {
		setActiveTab(next);
		setFieldFocus(0);
	}

	function advance(): void {
		const next = computeNextFocus({ activeTab, fieldFocus });
		if (next === 'done') {
			setDone(true);
			return;
		}
		setActiveTab(next.activeTab);
		setFieldFocus(next.fieldFocus);
	}

	function commitModel(phase: Phase, value: string): void {
		setModels((m) => ({ ...m, [phase]: value }));
		advance();
	}

	const customModel = useCustomModelEntry(commitModel);

	// Tab key advances focus without committing a value (AC6: an untouched
	// field defaults). Guarded off while the custom-model free-text input is
	// open: ink-text-input itself ignores key.tab, so without this guard Tab
	// would silently skip past an in-progress custom entry.
	useInput((_input, key) => {
		if (key.tab && customModel.phase === null) advance();
	});

	function handlePhaseSelect(phase: Phase, value: string): void {
		if (customModel.select(phase, value)) return;
		commitModel(phase, value);
	}

	function handleEffortSelect(phase: LlmPhase, value: string): void {
		setEfforts((e) => ({ ...e, [phase]: value }));
		advance();
	}

	function handleBackendSelect(value: string): void {
		setBackend(value);
		advance();
	}

	function handleMergeModeSelect(value: MergeMode): void {
		setMergeMode(value);
		advance();
	}

	function handlePlanApprovalSelect(value: PlanApproval): void {
		setPlanApproval(value);
		advance();
	}

	useFireOnDone(done, models, efforts, backend, mergeMode, planApproval, resendRecipient, resendFrom, onDone);

	return {
		activeTab,
		fieldFocus,
		models,
		efforts,
		backend,
		mergeMode,
		planApproval,
		resendRecipient,
		setResendRecipient,
		resendFrom,
		setResendFrom,
		done,
		changeTab,
		advance,
		customModel,
		handlePhaseSelect,
		handleEffortSelect,
		handleBackendSelect,
		handleMergeModeSelect,
		handlePlanApprovalSelect,
	};
}

export function ConfigScreen({ onDone, onCancel }: ConfigScreenProps): ReactElement {
	const s = useConfigScreenState(onDone);
	// RESEND_API_KEY is read-only status here: never a text input, never
	// persisted from this screen.
	const apiKeyConfigured = (process.env['RESEND_API_KEY'] ?? '') !== '';
	const currentTab: TabKind = TABS[s.activeTab] ?? 'global';

	return (
		<Box flexDirection="column">
			<Box marginTop={1}>
				<Text color={colors.accent} bold>
					cam config
				</Text>
			</Box>

			<Box marginTop={1}>
				<TabBar tabs={buildTabDefs(s.models)} activeIndex={s.activeTab} onChange={s.changeTab} />
			</Box>

			{currentTab === 'global' ? (
				<GlobalTabContent
					fieldFocus={s.fieldFocus}
					backend={s.backend}
					onBackendChange={s.handleBackendSelect}
					mergeMode={s.mergeMode}
					onMergeModeChange={s.handleMergeModeSelect}
					planApproval={s.planApproval}
					onPlanApprovalChange={s.handlePlanApprovalSelect}
					resendRecipient={s.resendRecipient}
					onRecipientChange={s.setResendRecipient}
					onRecipientSubmit={s.advance}
					resendFrom={s.resendFrom}
					onFromChange={s.setResendFrom}
					onFromSubmit={s.advance}
					apiKeyConfigured={apiKeyConfigured}
					onCancel={onCancel}
				/>
			) : (
				<PhaseTabContent
					phase={currentTab}
					fieldFocus={s.fieldFocus}
					model={s.models[currentTab]}
					efforts={s.efforts}
					customModel={s.customModel}
					onModelSelect={s.handlePhaseSelect}
					onEffortSelect={s.handleEffortSelect}
					onCancel={onCancel}
				/>
			)}

			{s.done ? (
				<Section heading="Saved" tone="accent">
					<Box flexDirection="row">
						<Text color={colors.accent}>✓ </Text>
						<Text>Configuration written to scripts/cam/project.toml</Text>
					</Box>
				</Section>
			) : null}
		</Box>
	);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fires `onDone` once the operator has advanced past the last field of the
 * last tab (`done` becomes true), applying phase/effort/backend/merge-mode/
 * plan-approval defaults for every untouched field (AC6). Extracted from
 * ConfigScreen to keep the component body under the lint line-count budget.
 */
function useFireOnDone(
	done: boolean,
	models: Partial<Record<Phase, string>>,
	efforts: Partial<Record<LlmPhase, string>>,
	backend: string | undefined,
	mergeMode: MergeMode | undefined,
	planApproval: PlanApproval | undefined,
	resendRecipient: string,
	resendFrom: string,
	onDone: (choices: ConfigChoices) => void,
): void {
	useEffect(() => {
		if (!done) return;
		const allModels = Object.fromEntries(
			PHASE_STEPS.map((p) => [p, models[p] ?? DEFAULTS[p]]),
		) as Record<Phase, string>;
		const allEfforts = Object.fromEntries(
			LLM_PHASES.map((p) => [p, efforts[p] ?? EFFORT_DEFAULTS[p]]),
		) as Record<LlmPhase, string>;
		const chosenBackend = backend ?? DEFAULTS.backend;
		const chosenMergeMode = mergeMode ?? 'immediate';
		const chosenPlanApproval = planApproval ?? 'auto';
		const id = setTimeout(() => {
			onDone({
				models: allModels,
				efforts: allEfforts,
				backend: chosenBackend,
				mergeMode: chosenMergeMode,
				planApproval: chosenPlanApproval,
				resendRecipient,
				resendFrom,
			});
		}, 0);
		return () => clearTimeout(id);
	}, [done, models, efforts, backend, mergeMode, planApproval, resendRecipient, resendFrom, onDone]);
}

// ---------------------------------------------------------------------------
// Phase tabs (Orchestrator..Ship): model Select + (LLM-only) effort Select
// ---------------------------------------------------------------------------

interface PhaseTabContentProps {
	phase: Phase;
	fieldFocus: number;
	model: string | undefined;
	efforts: Partial<Record<LlmPhase, string>>;
	customModel: ReturnType<typeof useCustomModelEntry>;
	onModelSelect: (phase: Phase, value: string) => void;
	onEffortSelect: (phase: LlmPhase, value: string) => void;
	onCancel: () => void;
}

// AC2: every LLM-phase tab renders model + effort; the Ship tab renders the
// model Select only (ship has no effort concept, ADR-0009).
function PhaseTabContent({
	phase,
	fieldFocus,
	model,
	efforts,
	customModel,
	onModelSelect,
	onEffortSelect,
	onCancel,
}: PhaseTabContentProps): ReactElement {
	return (
		<Section heading={PHASE_LABELS[phase]}>
			<ModelField
				phase={phase}
				value={model}
				active={fieldFocus === 0}
				customModel={customModel}
				onChange={(v) => onModelSelect(phase, v)}
				onCancel={onCancel}
			/>
			{phase === 'ship' ? null : (
				<EffortField
					phase={phase}
					value={efforts[phase]}
					active={fieldFocus === 1}
					onChange={(v) => onEffortSelect(phase, v)}
					onCancel={onCancel}
				/>
			)}
		</Section>
	);
}

interface ModelFieldProps {
	phase: Phase;
	value: string | undefined;
	active: boolean;
	customModel: ReturnType<typeof useCustomModelEntry>;
	onChange: (v: string) => void;
	onCancel: () => void;
}

function ModelField({ phase, value, active, customModel, onChange, onCancel }: ModelFieldProps): ReactElement {
	const showCustomInput = active && customModel.phase === phase;
	// NOTE: unlike EffortField/BackendField/etc., the model field cannot use
	// Select's own confirmed/confirmedValue props for its inactive summary
	// line: a custom-entered model id (US-002) is, by definition, NOT one of
	// PHASE_MODEL_OPTIONS' fixed values, so Select's confirmed-mode lookup
	// (`options.find(o => o.value === confirmedValue)`) would miss it and fall
	// back to whatever the list's internal cursor idx happens to be. The
	// standalone ConfirmedChoice component (used here, and by the old wizard
	// for the same reason) always renders the literal current value verbatim.
	return (
		<Box flexDirection="column">
			<Text bold color={colors.muted}>
				Model
			</Text>
			{showCustomInput ? (
				<CustomModelInput
					value={customModel.draft}
					onChange={customModel.setDraft}
					onSubmit={(v) => customModel.submit(phase, v)}
				/>
			) : active ? (
				<Select
					question={`Model for ${phase}:`}
					options={PHASE_MODEL_OPTIONS}
					defaultValue={value ?? DEFAULTS[phase]}
					onChange={onChange}
					onCancel={onCancel}
				/>
			) : (
				<ConfirmedChoice label={value ?? DEFAULTS[phase]} />
			)}
		</Box>
	);
}

interface EffortFieldProps {
	phase: LlmPhase;
	value: string | undefined;
	active: boolean;
	onChange: (v: string) => void;
	onCancel: () => void;
}

function EffortField({ phase, value, active, onChange, onCancel }: EffortFieldProps): ReactElement {
	return (
		<Box flexDirection="column" marginTop={1}>
			<Text bold color={colors.muted}>
				Effort
			</Text>
			<Select
				question={`Effort for ${phase}:`}
				options={EFFORT_OPTIONS}
				defaultValue={value ?? EFFORT_DEFAULTS[phase]}
				confirmed={!active}
				confirmedValue={value ?? EFFORT_DEFAULTS[phase]}
				onChange={onChange}
				onCancel={onCancel}
			/>
		</Box>
	);
}

// ---------------------------------------------------------------------------
// Global tab: backend, merge-mode, plan-approval, notify recipient/from
// ---------------------------------------------------------------------------

interface GlobalTabContentProps {
	fieldFocus: number;
	backend: string | undefined;
	onBackendChange: (v: string) => void;
	mergeMode: MergeMode | undefined;
	onMergeModeChange: (v: MergeMode) => void;
	planApproval: PlanApproval | undefined;
	onPlanApprovalChange: (v: PlanApproval) => void;
	resendRecipient: string;
	onRecipientChange: (v: string) => void;
	onRecipientSubmit: () => void;
	resendFrom: string;
	onFromChange: (v: string) => void;
	onFromSubmit: () => void;
	apiKeyConfigured: boolean;
	onCancel: () => void;
}

// AC3: parity with the old wizard's globals (backend/merge-mode/plan-approval
// + notify recipient/from), no new global fields added.
function GlobalTabContent(props: GlobalTabContentProps): ReactElement {
	return (
		<>
			<Section heading="Backend">
				<Select
					question="Backend:"
					options={BACKEND_OPTIONS}
					defaultValue={props.backend ?? DEFAULTS.backend}
					confirmed={props.fieldFocus !== 0}
					confirmedValue={props.backend ?? DEFAULTS.backend}
					onChange={props.onBackendChange}
					onCancel={props.onCancel}
				/>
			</Section>
			<Section heading="Merge mode">
				<Select
					question="How should cam ship merge pull requests?"
					options={MERGE_MODE_OPTIONS}
					defaultValue={props.mergeMode ?? 'immediate'}
					confirmed={props.fieldFocus !== 1}
					confirmedValue={props.mergeMode ?? 'immediate'}
					onChange={props.onMergeModeChange}
					onCancel={props.onCancel}
				/>
			</Section>
			<Section heading="Plan approval">
				<Select
					question="How should cam advance after a plan audit?"
					options={PLAN_APPROVAL_OPTIONS}
					defaultValue={props.planApproval ?? 'auto'}
					confirmed={props.fieldFocus !== 2}
					confirmedValue={props.planApproval ?? 'auto'}
					onChange={props.onPlanApprovalChange}
					onCancel={props.onCancel}
				/>
			</Section>
			<Section heading="Notify recipient">
				<ApiKeyStatus configured={props.apiKeyConfigured} />
				{props.fieldFocus === 3 ? (
					<NotifyTextInput
						value={props.resendRecipient}
						onChange={props.onRecipientChange}
						onSubmit={props.onRecipientSubmit}
						prompt="resend_recipient (email notified on escalation, blank to leave unset):"
						placeholder="e.g. ops@example.com"
					/>
				) : (
					<ConfirmedChoice label={props.resendRecipient !== '' ? props.resendRecipient : '(not set)'} />
				)}
			</Section>
			<Section heading="Notify sender">
				{props.fieldFocus === 4 ? (
					<NotifyTextInput
						value={props.resendFrom}
						onChange={props.onFromChange}
						onSubmit={props.onFromSubmit}
						prompt="resend_from (sender address, blank to leave unset):"
						placeholder='e.g. "cam" <notify@example.com>'
					/>
				) : (
					<ConfirmedChoice label={props.resendFrom !== '' ? props.resendFrom : '(not set)'} />
				)}
			</Section>
		</>
	);
}

function ApiKeyStatus({ configured }: { configured: boolean }): ReactElement {
	return (
		<Box flexDirection="row" marginBottom={1}>
			<Text color={configured ? colors.accent : colors.destructive}>{configured ? '✓ ' : '✗ '}</Text>
			<Text color={colors.muted}>
				RESEND_API_KEY {configured ? 'configured' : 'not configured'} (read from environment; never entered here)
			</Text>
		</Box>
	);
}

function ConfirmedChoice({ label }: { label: string }): ReactElement {
	return (
		<Box flexDirection="row">
			<Text color={colors.accent}>✓ </Text>
			<Text>{label}</Text>
		</Box>
	);
}

interface CustomModelInputProps {
	value: string;
	onChange: (v: string) => void;
	onSubmit: (v: string) => void;
}

// Free-text passthrough for the 'custom / enter id' picker entry — mirrors
// SetupScreen's description TextInput (ink-text-input). The typed value is
// stored verbatim (trimmed) in ConfigChoices.models, with no allowlist check.
function CustomModelInput({ value, onChange, onSubmit }: CustomModelInputProps): ReactElement {
	return (
		<Box flexDirection="column">
			<Text color={undefined}>Enter a model id:</Text>
			<Box marginTop={1} flexDirection="row">
				<Text color={colors.accent}>› </Text>
				<TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder="e.g. claude-sonnet-4-5-20250929" />
			</Box>
			<Box marginTop={1} paddingLeft={2}>
				<Text color={colors.muted}>enter confirm · esc back</Text>
			</Box>
		</Box>
	);
}

interface NotifyTextInputProps {
	value: string;
	onChange: (v: string) => void;
	onSubmit: (v: string) => void;
	prompt: string;
	placeholder: string;
}

// Free-text field for notify_recipient / notify_from -- mirrors
// CustomModelInput's ink-text-input pattern. Unlike CustomModelInput, a blank
// submit is valid here: it means "leave this field unset".
function NotifyTextInput({ value, onChange, onSubmit, prompt, placeholder }: NotifyTextInputProps): ReactElement {
	return (
		<Box flexDirection="column">
			<Text color={undefined}>{prompt}</Text>
			<Box marginTop={1} flexDirection="row">
				<Text color={colors.accent}>› </Text>
				<TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={placeholder} />
			</Box>
			<Box marginTop={1} paddingLeft={2}>
				<Text color={colors.muted}>enter confirm (blank = leave unset) · tab/enter next</Text>
			</Box>
		</Box>
	);
}
