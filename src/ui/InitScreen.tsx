// src/ui/InitScreen.tsx
//
// Interactive Ink screen for `cam init`. Renders a vertical list of checks
// with per-row status: pending (◌, muted) → running (spinner, accent) →
// ok (✓, accent) / warn (!, warning) / fail (✗, destructive).

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

import { colors } from './theme.ts';

export type CheckStatus = 'pending' | 'running' | 'ok' | 'warn' | 'fail';

export interface CheckOutcome {
	status: 'ok' | 'warn' | 'fail';
	/** Right-aligned secondary text on the row (e.g. version, "ready"). */
	detail?: string;
	/** Extra line printed under the row in muted color (e.g. install hint). */
	hint?: string;
}

export interface CheckDef {
	id: string;
	label: string;
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

/**
 * Minimum time a row stays in the "running" state. Without this floor, a
 * check that returns in <10ms would never render its spinner — the row would
 * flip straight from pending to ok, which feels like nothing happened.
 */
const MIN_RUNNING_MS = 140;

const COL_INDICATOR = 4;
const COL_LABEL = 22;

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

	// Fire onDone *after* React commits the final frame (summary line). If we
	// called it inside the async loop, the parent might unmount Ink before the
	// summary paints and the operator would never see "Machine ready" / "X
	// checks failed".
	useEffect(() => {
		if (!done) return;
		const id = setTimeout(() => onDone(failedIdsRef.current), 0);
		return () => clearTimeout(id);
	}, [done, onDone]);

	return (
		<Box flexDirection="column" paddingX={1} paddingY={1}>
			<Text color={colors.accent} bold>
				cam init
			</Text>
			{!done && (
				<Box marginTop={1}>
					<Text>Checking your machine</Text>
				</Box>
			)}
			<Box flexDirection="column" marginTop={1}>
				{checks.map((c, idx) => (
					<CheckRow key={c.id} label={c.label} state={rows[idx]!} />
				))}
			</Box>
			{done && (
				<Box marginTop={1}>
					{failedIdsRef.current.length === 0 ? (
						<Text color={colors.accent}>Machine ready</Text>
					) : (
						<Text color={colors.destructive}>
							{failedIdsRef.current.length} check
							{failedIdsRef.current.length === 1 ? '' : 's'} failed
						</Text>
					)}
				</Box>
			)}
		</Box>
	);
}

function CheckRow({ label, state }: { label: string; state: RowState }): ReactElement {
	const isPending = state.status === 'pending';
	return (
		<Box flexDirection="column">
			<Box flexDirection="row">
				<Box width={COL_INDICATOR}>
					<Indicator status={state.status} />
				</Box>
				<Box width={COL_LABEL}>
					<Text color={isPending ? colors.muted : undefined}>{label}</Text>
				</Box>
				<Box flexGrow={1}>
					<Text color={isPending ? colors.muted : undefined}>{detailText(state)}</Text>
				</Box>
			</Box>
			{state.hint ? (
				<Box marginLeft={COL_INDICATOR}>
					<Text color={colors.muted}>{state.hint}</Text>
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
			return 'running...';
		case 'ok':
		case 'warn':
		case 'fail':
			return state.detail ?? '';
	}
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
