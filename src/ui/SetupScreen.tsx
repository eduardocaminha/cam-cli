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

export interface SetupAnswers {
	projectMode: ProjectMode;
	issueSystem: IssueSystem;
	description: string;
}

interface SetupScreenProps {
	prefilled: Partial<SetupAnswers>;
	onDone: (answers: SetupAnswers) => void;
	onCancel: () => void;
}

type Step = 'mode' | 'issue' | 'description' | 'done';

const MODE_OPTIONS: readonly SelectOption<ProjectMode>[] = [
	{ value: 'existing', label: 'Existing project', description: 'This folder already has code.' },
	{ value: 'new', label: 'New project', description: 'Empty folder, scaffold from scratch.' },
];

const ISSUE_OPTIONS: readonly SelectOption<IssueSystem>[] = [
	{ value: 'linear', label: 'Linear', description: 'Issues at app.linear.app' },
	{ value: 'github', label: 'GitHub', description: 'Issues at github.com/.../issues' },
	{ value: 'none', label: 'None', description: 'Local-only, no external tracker' },
];

export function SetupScreen({ prefilled, onDone, onCancel }: SetupScreenProps): ReactElement {
	const [projectMode, setProjectMode] = useState<ProjectMode | undefined>(prefilled.projectMode);
	const [issueSystem, setIssueSystem] = useState<IssueSystem | undefined>(prefilled.issueSystem);
	const [description, setDescription] = useState<string | undefined>(prefilled.description);
	const [descDraft, setDescDraft] = useState<string>('');

	const step: Step = (() => {
		if (projectMode === undefined) return 'mode';
		if (issueSystem === undefined) return 'issue';
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
				description: description ?? '',
			});
		}, 0);
		return () => clearTimeout(id);
	}, [step, projectMode, issueSystem, description, onDone]);

	const showProjectSummary = projectMode !== undefined && step !== 'mode';
	const showIssueSection = projectMode !== undefined;
	const showIssueSummary = issueSystem !== undefined && step !== 'issue';
	const showDescriptionSection =
		projectMode === 'new' && issueSystem !== undefined;

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
						<Text color={colors.muted}>Ready to drive the loop.</Text>
					</Section>
					<Section heading="Next">
						<NextCommand name="cam run" hint="open or attach the orchestrator" />
						<NextCommand name="cam plan" hint="plan an issue and create a PRD" />
						<NextCommand name="cam help" hint="list available commands" />
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
