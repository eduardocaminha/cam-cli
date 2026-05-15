// src/ui/InitScreen.tsx
//
// Interactive Ink screen for `cam init`. Layout follows the target mock in
// `img/ui-snapshot.txt`:
//
//   cam init                                    (--primary, bold, flush-left)
//
//     Checking prerequisites                    (Section heading)
//     ──────────────────────────────────────    (muted divisor)
//        ✓ claude              2.0.5            (CheckRow)
//          Required to spawn Claude Code sessions.
//        ◌ agent-frontmatter   pending
//          Validates .claude/agents/*.md files.
//        ◌ config              pending
//          Saves your default permission mode.
//
//     All set                                   (success Section, accent divisor)
//     ──────────────────────────────────────
//        ✓ 3/3 checks passed
//        Ready to drive the loop.
//
//     Next                                      (default Section, muted divisor)
//     ──────────────────────────────────────
//        cam run     open or attach the orchestrator
//        cam plan    plan an issue and create a PRD
//        cam help    list available commands
//
// The failure path swaps "All set" for a destructive Section called "Failed"
// and renders an inline `Fix:` hint under every fail/warn row.

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

import { colors } from './theme.ts';
import { Section } from './Section.tsx';

export type CheckStatus = 'pending' | 'running' | 'ok' | 'warn' | 'fail';

export interface CheckOutcome {
	status: 'ok' | 'warn' | 'fail';
	/** Secondary text rendered on the row (e.g. version, "ok", "written"). */
	detail?: string;
	/** Inline `Fix:` hint shown under the row when status is fail or warn. */
	hint?: string;
}

export interface CheckDef {
	id: string;
	label: string;
	/**
	 * One-line description that always renders under the row (mutedForeground).
	 * Distinct from `CheckOutcome.hint`, which only shows on fail/warn and
	 * prefixes with `Fix:`.
	 */
	description?: string;
	run: () => CheckOutcome | Promise<CheckOutcome>;
}

interface InitScreenProps {
	checks: CheckDef[];
	onDone: (failedIds: string[]) => void;
}

interface RowState {
	status: CheckStatus;
	detail?: string;
	hint?: string;
}

/** Spinner-floor: keeps every row visibly "running" for at least this long. */
const MIN_RUNNING_MS = 140;

/** Width of the label column. Detail text starts at this column boundary. */
const COL_LABEL = 20;

export function InitScreen({ checks, onDone }: InitScreenProps): ReactElement {
	const [rows, setRows] = useState<RowState[]>(() =>
		checks.map(() => ({ status: 'pending' as CheckStatus })),
	);
	const [done, setDone] = useState(false);
	const failedIdsRef = useRef<string[]>([]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			for (let i = 0; i < checks.length; i += 1) {
				if (cancelled) return;
				const def = checks[i]!;
				setRows((r) => updateRow(r, i, { status: 'running' }));
				const started = Date.now();
				let outcome: CheckOutcome;
				try {
					outcome = await Promise.resolve(def.run());
				} catch (err) {
					outcome = {
						status: 'fail',
						detail: err instanceof Error ? err.message : String(err),
					};
				}
				const elapsed = Date.now() - started;
				if (elapsed < MIN_RUNNING_MS) {
					await new Promise((resolve) => setTimeout(resolve, MIN_RUNNING_MS - elapsed));
				}
				if (cancelled) return;
				setRows((r) =>
					updateRow(r, i, {
						status: outcome.status,
						detail: outcome.detail,
						hint: outcome.hint,
					}),
				);
				if (outcome.status === 'fail') {
					failedIdsRef.current.push(def.id);
				}
			}
			if (cancelled) return;
			setDone(true);
		})().catch(() => {
			/* unreachable — every run() is wrapped above */
		});
		return () => {
			cancelled = true;
		};
		// run-once on mount; checks/onDone are stable per render of the host
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Fire onDone *after* React commits the final summary so the operator sees
	// the trailing "All set" / "Failed" block before the parent unmounts Ink.
	useEffect(() => {
		if (!done) return;
		const id = setTimeout(() => onDone(failedIdsRef.current), 0);
		return () => clearTimeout(id);
	}, [done, onDone]);

	const failedCount = failedIdsRef.current.length;
	const total = checks.length;
	const passed = total - failedCount;

	return (
		<Box flexDirection="column">
			<Box marginTop={1}>
				<Text color={colors.accent} bold>
					cam init
				</Text>
			</Box>

			<Section heading="Checking prerequisites">
				{checks.map((c, idx) => (
					<CheckRow key={c.id} def={c} state={rows[idx]!} />
				))}
			</Section>

			{done && failedCount === 0 && (
				<Section heading="All set">
					<Box flexDirection="row">
						<Text color={colors.accent}>✓ </Text>
						<Text>
							{passed}/{total} checks passed
						</Text>
					</Box>
					<Text color={colors.muted}>Ready to drive the loop.</Text>
				</Section>
			)}

			{done && failedCount > 0 && (
				<Section heading="Failed">
					<Box flexDirection="row">
						<Text color={colors.destructive}>✗ </Text>
						<Text>
							{failedCount} required check{failedCount === 1 ? '' : 's'} did not pass
						</Text>
					</Box>
					<Text color={colors.muted}>
						Fix the issue{failedCount === 1 ? '' : 's'} above before continuing.
					</Text>
				</Section>
			)}

			{done && failedCount === 0 && (
				<Section heading="Next">
					<NextCommand name="cam run" hint="open or attach the orchestrator" />
					<NextCommand name="cam plan" hint="plan an issue and create a PRD" />
					<NextCommand name="cam help" hint="list available commands" />
				</Section>
			)}
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

function CheckRow({ def, state }: { def: CheckDef; state: RowState }): ReactElement {
	const isPending = state.status === 'pending';
	const labelColor = isPending ? colors.muted : undefined;
	const detailColor = isPending ? colors.muted : colors.muted;
	return (
		<Box flexDirection="column" marginTop={1}>
			<Box flexDirection="row">
				<Indicator status={state.status} />
				<Text> </Text>
				<Box width={COL_LABEL}>
					<Text color={labelColor}>{def.label}</Text>
				</Box>
				<Text color={detailColor}>{detailText(state)}</Text>
			</Box>
			{def.description ? (
				<Box paddingLeft={2}>
					<Text color={colors.muted}>{def.description}</Text>
				</Box>
			) : null}
			{state.hint ? (
				<Box paddingLeft={2}>
					<Text color={hintColor(state.status)}>Fix: {state.hint}</Text>
				</Box>
			) : null}
		</Box>
	);
}

function detailText(state: RowState): string {
	switch (state.status) {
		case 'pending':
			return 'pending';
		case 'running':
			return 'Running...';
		case 'ok':
		case 'warn':
		case 'fail':
			return state.detail ?? '';
	}
}

function hintColor(status: CheckStatus): string {
	if (status === 'fail') return colors.destructive;
	if (status === 'warn') return colors.warning;
	return colors.muted;
}

function Indicator({ status }: { status: CheckStatus }): ReactElement {
	switch (status) {
		case 'pending':
			return <Text color={colors.muted}>◌</Text>;
		case 'running':
			return (
				<Text color={colors.accent}>
					<Spinner type="dots" />
				</Text>
			);
		case 'ok':
			return <Text color={colors.accent}>✓</Text>;
		case 'warn':
			return <Text color={colors.warning}>!</Text>;
		case 'fail':
			return <Text color={colors.destructive}>✗</Text>;
	}
}

function updateRow(rows: RowState[], idx: number, patch: Partial<RowState>): RowState[] {
	const next = rows.slice();
	const current = next[idx]!;
	next[idx] = { ...current, ...patch };
	return next;
}
