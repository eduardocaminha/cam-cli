// src/ui/ConfigScreen.tsx
//
// Multi-step wizard for cam model configuration.
//
// Steps: one per phase (orchestrator, planner, auditor, implementer, reviewer,
// ship) followed by the backend step. After all steps, fires onDone with the
// chosen ConfigChoices.
//
// Layout mirrors SetupScreen.tsx: each completed step collapses to a one-line
// "✓ <chosen>" summary; the active step renders a Select with ❯ cursor nav.
// Future steps are hidden until prior ones are answered.
//
// Success/failure is always signalled by the glyph (✓/✗), never by divider
// color (patterns.md: "Ink screens: success/failure is the glyph, not divider
// color").

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text } from 'ink';

import { colors } from './theme.ts';
import { Section } from './Section.tsx';
import { Select, type SelectOption } from './Select.tsx';
import { DEFAULTS } from '../config/models.ts';
import type { Phase, MergeMode } from '../config/models.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConfigChoices = {
	models: Record<Phase, string>;
	backend: string;
	mergeMode?: MergeMode;
};

type WizardStep = Phase | 'backend' | 'merge-mode' | 'done';

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

const PHASE_LABELS: Record<Phase, string> = {
	orchestrator: 'Orchestrator',
	planner: 'Planner',
	auditor: 'Auditor',
	implementer: 'Implementer',
	reviewer: 'Reviewer',
	ship: 'Ship',
};

const MODEL_OPTIONS: readonly SelectOption<string>[] = [
	{ value: 'claude-opus-4-8', label: 'claude-opus-4-8', description: 'Deep reasoning, highest quality' },
	{ value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', description: 'Balanced performance' },
	{ value: 'claude-haiku-3-5', label: 'claude-haiku-3-5', description: 'Fast and economical' },
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

// ---------------------------------------------------------------------------
// ConfigScreen component
// ---------------------------------------------------------------------------

interface ConfigScreenProps {
	onDone: (choices: ConfigChoices) => void;
	onCancel: () => void;
}

export function ConfigScreen({ onDone, onCancel }: ConfigScreenProps): ReactElement {
	const [stepIdx, setStepIdx] = useState(0);
	const [models, setModels] = useState<Partial<Record<Phase, string>>>({});
	const [backend, setBackend] = useState<string | undefined>(undefined);
	const [mergeMode, setMergeMode] = useState<MergeMode | undefined>(undefined);

	const allSteps: readonly WizardStep[] = [...PHASE_STEPS, 'backend', 'merge-mode', 'done'];
	const currentStep: WizardStep = allSteps[stepIdx] ?? 'done';

	// After every choice is made the currentStep becomes 'done'. Fire onDone
	// after React commits the final summary so the operator sees the ✓ rows.
	useEffect(() => {
		if (currentStep !== 'done') return;
		const allModels = Object.fromEntries(
			PHASE_STEPS.map((p) => [p, models[p] ?? DEFAULTS[p]]),
		) as Record<Phase, string>;
		const chosenBackend = backend ?? DEFAULTS.backend;
		const chosenMergeMode = mergeMode ?? 'immediate';
		const id = setTimeout(() => {
			onDone({ models: allModels, backend: chosenBackend, mergeMode: chosenMergeMode });
		}, 0);
		return () => clearTimeout(id);
	}, [currentStep, models, backend, mergeMode, onDone]);

	function handlePhaseSelect(phase: Phase, value: string): void {
		setModels((m) => ({ ...m, [phase]: value }));
		setStepIdx((i) => i + 1);
	}

	function handleBackendSelect(value: string): void {
		setBackend(value);
		setStepIdx((i) => i + 1);
	}

	function handleMergeModeSelect(value: MergeMode): void {
		setMergeMode(value);
		setStepIdx((i) => i + 1);
	}

	return (
		<Box flexDirection="column">
			<Box marginTop={1}>
				<Text color={colors.accent} bold>
					cam config
				</Text>
			</Box>

			{PHASE_STEPS.map((phase, phaseIdx) => {
				const isActive = stepIdx === phaseIdx;
				const isDone = stepIdx > phaseIdx;

				if (!isActive && !isDone) return null;

				return (
					<Section key={phase} heading={PHASE_LABELS[phase]}>
						{isActive ? (
							<Select
								question={`Model for ${phase}:`}
								options={MODEL_OPTIONS}
								defaultValue={DEFAULTS[phase]}
								onChange={(v) => handlePhaseSelect(phase, v)}
								onCancel={onCancel}
							/>
						) : null}
						{isDone ? (
							<ConfirmedChoice label={models[phase] ?? DEFAULTS[phase]} />
						) : null}
					</Section>
				);
			})}

			{stepIdx >= PHASE_STEPS.length ? (
				<Section heading="Backend">
					{currentStep === 'backend' ? (
						<Select
							question="Backend:"
							options={BACKEND_OPTIONS}
							defaultValue={DEFAULTS.backend}
							onChange={handleBackendSelect}
							onCancel={onCancel}
						/>
					) : backend !== undefined ? (
						<ConfirmedChoice label={backend} />
					) : null}
				</Section>
			) : null}

			{stepIdx >= PHASE_STEPS.length + 1 ? (
				<Section heading="Merge mode">
					{currentStep === 'merge-mode' ? (
						<Select
							question="How should cam ship merge pull requests?"
							options={MERGE_MODE_OPTIONS}
							defaultValue="immediate"
							onChange={handleMergeModeSelect}
							onCancel={onCancel}
						/>
					) : mergeMode !== undefined ? (
						<ConfirmedChoice label={mergeModeLabel(mergeMode)} />
					) : null}
				</Section>
			) : null}

			{currentStep === 'done' ? (
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

function ConfirmedChoice({ label }: { label: string }): ReactElement {
	return (
		<Box flexDirection="row">
			<Text color={colors.accent}>✓ </Text>
			<Text>{label}</Text>
		</Box>
	);
}

function mergeModeLabel(mode: MergeMode): string {
	return mode === 'ci-gated' ? 'CI-gated' : 'Immediate (default)';
}
