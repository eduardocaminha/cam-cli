// src/ui/SetupScreen.tsx
//
// Interactive wizard for the three setup questions: project mode, issue
// system, optional description. Renders as a single Ink screen with a
// running history of confirmed answers above the current question, so the
// user sees a Claude-Code-style transcript instead of disconnected prompts.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

import { colors } from './theme.ts';
import { Select } from './Select.tsx';
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

const MODE_OPTIONS = [
	{ value: 'existing' as const, label: 'Existing project', description: 'This folder already has code' },
	{ value: 'new' as const, label: 'New project', description: 'Empty folder, scaffold from scratch' },
];

const ISSUE_OPTIONS = [
	{ value: 'linear' as const, label: 'Linear', description: 'Issues at app.linear.app' },
	{ value: 'github' as const, label: 'GitHub', description: 'Issues at github.com/.../issues' },
	{ value: 'none' as const, label: 'None', description: 'Local-only, no external tracker' },
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

	// Fire onDone *after* React commits the final history line. setTimeout(0)
	// defers to the next tick so the last "✓ ..." paints before the parent
	// unmounts Ink in response.
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

	return (
		<Box flexDirection="column" paddingX={1} paddingY={1}>
			<Text color={colors.accent} bold>
				cam setup
			</Text>

			<Box flexDirection="column" marginTop={1}>
				{projectMode !== undefined && <Confirmed label={modeLabel(projectMode)} />}
				{issueSystem !== undefined && <Confirmed label={issueLabel(issueSystem)} />}
				{step === 'done' && description !== undefined && description !== '' && (
					<Confirmed label={`About: ${description}`} />
				)}
				{step === 'done' && projectMode === 'new' && description === '' && (
					<Confirmed label="About: (skipped — agent will infer)" muted />
				)}
			</Box>

			{step === 'mode' && (
				<Box marginTop={1}>
					<Select
						question="Is this a new or existing project?"
						options={MODE_OPTIONS}
						defaultValue="existing"
						onChange={setProjectMode}
						onCancel={onCancel}
					/>
				</Box>
			)}

			{step === 'issue' && (
				<Box marginTop={1}>
					<Select
						question="Which issue system does this project use?"
						options={ISSUE_OPTIONS}
						defaultValue="none"
						onChange={setIssueSystem}
						onCancel={onCancel}
					/>
				</Box>
			)}

			{step === 'description' && (
				<Box marginTop={1} flexDirection="column">
					<Text bold>What is this project about?</Text>
					<Box marginTop={1} flexDirection="row">
						<Text color={colors.muted}>› </Text>
						<TextInput value={descDraft} onChange={setDescDraft} placeholder="short summary" />
					</Box>
					<Box marginTop={1}>
						<Text color={colors.muted}>⏎ confirm · esc skip</Text>
					</Box>
				</Box>
			)}
		</Box>
	);
}

function Confirmed({ label, muted = false }: { label: string; muted?: boolean }): ReactElement {
	return (
		<Box flexDirection="row">
			<Text color={muted ? colors.muted : colors.accent}>✓ </Text>
			<Text color={muted ? colors.muted : undefined}>{label}</Text>
		</Box>
	);
}

function modeLabel(mode: ProjectMode): string {
	return mode === 'new' ? 'New project' : 'Existing project';
}

function issueLabel(issue: IssueSystem): string {
	return issue === 'linear' ? 'Linear' : issue === 'github' ? 'GitHub' : 'None';
}
