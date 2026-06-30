// src/ui/SetupScreen.tsx
//
// Interactive wizard for the three setup questions: project mode, issue
// system, optional project description. Layout follows the target mock in
// `img/ui-snapshot.txt`:
//
//   cam setup
//
//     Project
//     ──────────────────────────────────────────────
//       Is this a new or existing project?                (active prompt)
//       ❯ Existing project   This folder already has code.
//         New project        Empty folder, scaffold from scratch.
//
//     Issue system                                        (only after Project answered)
//     ──────────────────────────────────────────────
//       ✓ Existing project                                (collapsed previous Section)
//         This folder already has code.
//
//   When everything is confirmed:
//     All set                                             (success Section)
//     ──────────────────────────────────────────────
//       ✓ Project configuration saved
//       Ready to drive the loop.
//
//     Next                                                (default Section)
//     ──────────────────────────────────────────────
//       cam run     open or attach the orchestrator
//       …
//
// Sections that have already been answered render the collapsed `✓ label /
// description` summary; the active Section renders its Select (or text input
// for the description). Future sections aren't rendered until previous ones
// are answered.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

import { colors } from './theme.ts';
import { Section } from './Section.tsx';
import { Select, type SelectOption } from './Select.tsx';
import type { ProjectMode, IssueSystem } from '../commands/setup.ts';
import type { MergeMode, PlanApproval } from '../config/models.ts';

export interface SetupAnswers {
	projectMode: ProjectMode;
	issueSystem: IssueSystem;
	mergeMode: MergeMode;
	planApproval: PlanApproval;
	description: string;
}

interface SetupScreenProps {
	prefilled: Partial<SetupAnswers>;
	onDone: (answers: SetupAnswers) => void;
	onCancel: () => void;
}

type Step = 'mode' | 'issue' | 'merge' | 'plan-approval' | 'description' | 'done';

const MODE_OPTIONS: readonly SelectOption<ProjectMode>[] = [
	{ value: 'existing', label: 'Existing project', description: 'This folder already has code' },
	{ value: 'new', label: 'New project', description: 'Empty folder, scaffold from scratch' },
];

const ISSUE_OPTIONS: readonly SelectOption<IssueSystem>[] = [
	{ value: 'linear', label: 'Linear', description: 'Issues at app.linear.app' },
	{ value: 'github', label: 'GitHub', description: 'Issues at github.com/.../issues' },
	{ value: 'none', label: 'None', description: 'Local-only, no external tracker' },
];

const MERGE_OPTIONS: readonly SelectOption<MergeMode>[] = [
	{ value: 'immediate', label: 'Immediate (default)', description: 'Merge PR as soon as it is created' },
	{ value: 'ci-gated', label: 'CI-gated', description: 'Wait for CI to pass before merging' },
];

const PLAN_APPROVAL_OPTIONS: readonly SelectOption<PlanApproval>[] = [
	{ value: 'auto', label: 'Auto (default)', description: 'Sidecar advances automatically after plan audit' },
	{ value: 'operator', label: 'Operator gate', description: 'Pause for human approval before each loop' },
];

export function SetupScreen({ prefilled, onDone, onCancel }: SetupScreenProps): ReactElement {
	const [projectMode, setProjectMode] = useState<ProjectMode | undefined>(prefilled.projectMode);
	const [issueSystem, setIssueSystem] = useState<IssueSystem | undefined>(prefilled.issueSystem);
	const [mergeMode, setMergeMode] = useState<MergeMode | undefined>(prefilled.mergeMode);
	const [planApproval, setPlanApproval] = useState<PlanApproval | undefined>(prefilled.planApproval);
	const [description, setDescription] = useState<string | undefined>(prefilled.description);
	const [descDraft, setDescDraft] = useState<string>('');

	const step: Step = (() => {
		if (projectMode === undefined) return 'mode';
		if (issueSystem === undefined) return 'issue';
		if (mergeMode === undefined) return 'merge';
		if (planApproval === undefined) return 'plan-approval';
		if (projectMode === 'new' && description === undefined) return 'description';
		return 'done';
	})();

	// Enter / Esc on the description text input. (TextInput consumes typing
	// keys; we still receive return/escape here.)
	useInput(
		(_input, key) => {
			if (step !== 'description') return;
			if (key.return) setDescription(descDraft);
			else if (key.escape) setDescription('');
		},
		{ isActive: step === 'description' },
	);

	// Fire onDone *after* React commits the final summary so the operator sees
	// the trailing "All set" / "Next" Sections before the parent unmounts Ink.
	useEffect(() => {
		if (step !== 'done') return;
		const id = setTimeout(() => {
			onDone({
				projectMode: projectMode!,
				issueSystem: issueSystem!,
				mergeMode: mergeMode!,
				planApproval: planApproval!,
				description: description ?? '',
			});
		}, 0);
		return () => clearTimeout(id);
	}, [step, projectMode, issueSystem, mergeMode, planApproval, description, onDone]);

	const showProjectSummary = projectMode !== undefined && step !== 'mode';
	const showIssueSection = projectMode !== undefined;
	const showIssueSummary = issueSystem !== undefined && step !== 'issue';
	const showMergeSection = issueSystem !== undefined;
	const showMergeSummary = mergeMode !== undefined && step !== 'merge';
	const showPlanApprovalSection = mergeMode !== undefined;
	const showPlanApprovalSummary = planApproval !== undefined && step !== 'plan-approval';
	const showDescriptionSection =
		projectMode === 'new' && issueSystem !== undefined && mergeMode !== undefined && planApproval !== undefined;

	return (
		<Box flexDirection="column">
			<Box marginTop={1}>
				<Text color={colors.accent} bold>
					cam setup
				</Text>
			</Box>

			<Section heading="Project">
				{step === 'mode' ? (
					<Select
						question="Is this a new or existing project?"
						options={MODE_OPTIONS}
						defaultValue="existing"
						onChange={setProjectMode}
						onCancel={onCancel}
					/>
				) : null}
				{showProjectSummary ? (
					<ConfirmedAnswer
						label={modeLabel(projectMode!)}
						description={MODE_OPTIONS.find((o) => o.value === projectMode)?.description}
					/>
				) : null}
			</Section>

			{showIssueSection ? (
				<Section heading="Issue system">
					{step === 'issue' ? (
						<Select
							question="Which issue system does this project use?"
							options={ISSUE_OPTIONS}
							defaultValue="none"
							onChange={setIssueSystem}
							onCancel={onCancel}
						/>
					) : null}
					{showIssueSummary ? (
						<ConfirmedAnswer
							label={issueLabel(issueSystem!)}
							description={ISSUE_OPTIONS.find((o) => o.value === issueSystem)?.description}
						/>
					) : null}
				</Section>
			) : null}

			{showMergeSection ? (
				<Section heading="Merge mode">
					{step === 'merge' ? (
						<Select
							question="How should cam ship merge pull requests?"
							options={MERGE_OPTIONS}
							defaultValue="immediate"
							onChange={setMergeMode}
							onCancel={onCancel}
						/>
					) : null}
					{showMergeSummary ? (
						<ConfirmedAnswer
							label={mergeLabel(mergeMode!)}
							description={MERGE_OPTIONS.find((o) => o.value === mergeMode)?.description}
						/>
					) : null}
				</Section>
			) : null}

			{showPlanApprovalSection ? (
				<Section heading="Plan approval">
					{step === 'plan-approval' ? (
						<Select
							question="How should cam advance after a plan audit?"
							options={PLAN_APPROVAL_OPTIONS}
							defaultValue="auto"
							onChange={setPlanApproval}
							onCancel={onCancel}
						/>
					) : null}
					{showPlanApprovalSummary ? (
						<ConfirmedAnswer
							label={planApprovalLabel(planApproval!)}
							description={PLAN_APPROVAL_OPTIONS.find((o) => o.value === planApproval)?.description}
						/>
					) : null}
				</Section>
			) : null}

			{showDescriptionSection ? (
				<Section heading="Project summary">
					{step === 'description' ? (
						<>
							<Text color={undefined}>What is this project about?</Text>
							<Box marginTop={1} flexDirection="row">
								<Text color={colors.accent}>› </Text>
								<TextInput
									value={descDraft}
									onChange={setDescDraft}
									placeholder="short summary"
								/>
							</Box>
							<Box marginTop={1} paddingLeft={2}>
								<Text color={colors.muted}>enter confirm · esc skip</Text>
							</Box>
						</>
					) : description !== undefined && description !== '' ? (
						<ConfirmedAnswer label={description} description="About" />
					) : description !== undefined && description === '' ? (
						<ConfirmedAnswer label="(skipped — agent will infer)" description={undefined} muted />
					) : null}
				</Section>
			) : null}

			{step === 'done' ? (
				<>
					<Section heading="All set">
						<Box flexDirection="row">
							<Text color={colors.accent}>✓ </Text>
							<Text>Project configuration saved</Text>
						</Box>
						<Box paddingLeft={2}>
							<Text color={colors.muted}>Ready to drive the loop</Text>
						</Box>
					</Section>
					<Section heading="Next">
						<NextCommand key="cam-run" name="cam run" hint="open or attach the orchestrator" />
						<NextCommand key="cam-plan" name="cam plan" hint="plan an issue and create a PRD" />
						<NextCommand key="cam-help" name="cam help" hint="list available commands" />
					</Section>
				</>
			) : null}
		</Box>
	);
}

function NextCommand({ name, hint }: { name: string; hint: string }): ReactElement {
	return (
		<Box flexDirection="row">
			<Box width={12}>
				<Text color={undefined} bold>
					{name}
				</Text>
			</Box>
			<Text color={colors.muted}>{hint}</Text>
		</Box>
	);
}

function ConfirmedAnswer({
	label,
	description,
	muted = false,
}: {
	label: string;
	description?: string;
	muted?: boolean;
}): ReactElement {
	return (
		<Box flexDirection="column">
			<Box flexDirection="row">
				<Text color={muted ? colors.muted : colors.accent}>✓ </Text>
				<Text color={muted ? colors.muted : undefined}>
					{label}
				</Text>
			</Box>
			{description ? (
				<Box paddingLeft={2}>
					<Text color={colors.muted}>{description}</Text>
				</Box>
			) : null}
		</Box>
	);
}

function modeLabel(mode: ProjectMode): string {
	return mode === 'new' ? 'New project' : 'Existing project';
}

function issueLabel(issue: IssueSystem): string {
	return issue === 'linear' ? 'Linear' : issue === 'github' ? 'GitHub' : 'None';
}

function mergeLabel(mode: MergeMode): string {
	return mode === 'ci-gated' ? 'CI-gated' : 'Immediate (default)';
}

function planApprovalLabel(mode: PlanApproval): string {
	return mode === 'operator' ? 'Operator gate' : 'Auto (default)';
}
