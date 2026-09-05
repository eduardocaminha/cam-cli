// webui/src/screens/work-screen.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import type { DiagnosticFindingView, DiagnosticsView, IssueReviewDraft } from '../client.ts';
import { Badge } from '../components/ui/badge.tsx';
import type { BadgeVariant } from '../components/ui/badge.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardAction, CardDescription, CardDisclosure, CardHeader, CardPanel, CardSummary, CardTitle } from '../components/ui/card.tsx';
import { FormField, FormStack } from '../components/ui/card-layout.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Input } from '../components/ui/input.tsx';
import { SelectField } from '../components/ui/select.tsx';
import { Separator } from '../components/ui/separator.tsx';
import { Tabs, TabsCount, TabsList, TabsPanel, TabsTab } from '../components/ui/tabs.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { cn } from '../lib/cn.ts';
import { LOCALE_CATALOG } from '../locale.ts';
import type { Locale, WorkCatalog } from '../locale.ts';
import { actionsFor, activeRunIssueId } from '../run-view.ts';
import { SurfaceColumn } from './surface-column.tsx';
import { OperationalReadPanel } from '../operational-unavailable.tsx';
import { useState } from 'react';
import { ActionButton, BUTTON_CLASS, ContextPanel, PRIMARY_BUTTON_CLASS } from './operator-controls.tsx';
import { draftChanged } from './runs-screen.tsx';
import { fieldReader, formatCount } from './runs.tsx';

export function BacklogPanel({
	backlog,
	catalog,
	locale,
	selectedIssueId,
	canStart,
	onSelectIssue,
	onStart,
}: Pick<AppProps, 'backlog' | 'selectedIssueId' | 'onSelectIssue' | 'onStart'> & {
	canStart: boolean;
	catalog: WorkCatalog['backlog'];
	locale: Locale;
}): React.ReactElement {
	if (backlog.length === 0) {
		return (
			<Card data-state="empty">
				<CardHeader className="py-3">
					<CardTitle>{catalog.title}</CardTitle>
					<CardDescription>{catalog.description(0, formatCount(0, locale))}</CardDescription>
				</CardHeader>
			</Card>
		);
	}
	return (
		<ContextPanel
			description={catalog.description(backlog.length, formatCount(backlog.length, locale))}
			open
			title={catalog.title}
		>
			<div className="flex flex-col gap-3">
				<ul className="flex flex-col gap-1">
					{backlog.map((issue) => (
						<li key={issue.id}>
							<button
								aria-pressed={issue.id === selectedIssueId}
								className={cn(
									'flex w-full items-baseline gap-3 break-words rounded-lg border border-transparent px-3 py-2 text-left text-sm outline-none',
									'focus-visible:ring-2 focus-visible:ring-ring',
									issue.id === selectedIssueId
										? 'border-border bg-secondary text-foreground'
										: 'hover:bg-muted',
								)}
								onClick={() => onSelectIssue(issue.id)}
								type="button"
							>
								<span className="shrink-0 font-mono text-muted-foreground text-xs">{issue.id}</span>
								<span className="min-w-0 font-medium">{issue.title}</span>
							</button>
						</li>
					))}
				</ul>
				<div className="flex justify-end">
					<Button disabled={!canStart} onClick={onStart} type="button">
						{catalog.start}
					</Button>
				</div>
			</div>
		</ContextPanel>
	);
}

export function IssueIntakePanel({
	catalog,
	pending,
	onCreateIssue,
}: Pick<AppProps, 'pending' | 'onCreateIssue'> & { catalog: WorkCatalog }): React.ReactElement {
	return (
		<ContextPanel
			description={catalog.intake.description}
			title={catalog.intake.title}
		>
			<FormStack
				onSubmit={(event) => {
					event.preventDefault();
					const value = fieldReader(event.currentTarget);
					onCreateIssue({
						title: value('title'),
						scope: value('scope'),
						verificationCommand: value('verificationCommand'),
					});
				}}
			>
				<FormField className="text-sm" htmlFor="issue-title">
					<span className="font-medium">{catalog.form.title}</span>
					<Input id="issue-title" name="title" required />
				</FormField>
				<FormField className="text-sm" htmlFor="issue-scope">
					<span className="font-medium">{catalog.form.scope}</span>
					<Textarea className="min-h-24" id="issue-scope" name="scope" required />
				</FormField>
				<FormField className="text-sm" htmlFor="issue-command">
					<span className="font-medium">{catalog.form.verificationCommand}</span>
					<Input
						className="font-mono"
						id="issue-command"
						name="verificationCommand"
						placeholder={catalog.form.verificationPlaceholder}
						required
					/>
				</FormField>
				<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
					{catalog.intake.create}
				</button>
			</FormStack>
		</ContextPanel>
	);
}

export function IssueSpecifyPanel({
	catalog,
	ideas,
	pending,
	onSpecifyIssue,
}: Pick<AppProps, 'ideas' | 'pending' | 'onSpecifyIssue'> & { catalog: WorkCatalog }): React.ReactElement | null {
	if (ideas.length === 0) return null;
	return (
		<ContextPanel
			description={catalog.specification.description}
			title={catalog.specification.title}
		>
			<FormStack
				onSubmit={(event) => {
					event.preventDefault();
					const value = fieldReader(event.currentTarget);
					onSpecifyIssue(value('ideaId'), {
						scope: value('ideaScope'),
						verificationCommand: value('ideaVerificationCommand'),
					});
				}}
			>
				<FormField className="text-sm" htmlFor="idea-id">
					<span className="font-medium">{catalog.specification.idea}</span>
					<SelectField
						defaultValue={ideas[0]?.id}
						id="idea-id"
						items={ideas.map((idea) => ({ value: idea.id, label: `${idea.id} — ${idea.title}` }))}
						name="ideaId"
						required
					/>
				</FormField>
				<FormField className="text-sm" htmlFor="idea-scope">
					<span className="font-medium">{catalog.form.scope}</span>
					<Textarea className="min-h-24" id="idea-scope" name="ideaScope" required />
				</FormField>
				<FormField className="text-sm" htmlFor="idea-command">
					<span className="font-medium">{catalog.form.verificationCommand}</span>
					<Input
						className="font-mono"
						id="idea-command"
						name="ideaVerificationCommand"
						placeholder={catalog.form.verificationPlaceholder}
						required
					/>
				</FormField>
				<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
					{catalog.specification.submit}
				</button>
			</FormStack>
		</ContextPanel>
	);
}

/**
 * The three list fields both records carry, named once: the form edits them as
 * text, the read-only panel prints them, and neither spells the names twice.
 */

export function IssueReviewForm({
	catalog,
	draft,
	pending,
	onReviewIssue,
	onApproveIssue,
	onAbandonIssue,
}: Pick<AppProps, 'pending' | 'onReviewIssue' | 'onApproveIssue' | 'onAbandonIssue'> & {
	catalog: WorkCatalog;
	draft: IssueReviewDraft;
}): React.ReactElement {
	const [scope, setScope] = useState(draft.scope);
	const [verificationCommand, setVerificationCommand] = useState(draft.verificationCommand);
	const [confirmed, setConfirmed] = useState(false);
	const [abandonReason, setAbandonReason] = useState('');
	const [abandonConfirmed, setAbandonConfirmed] = useState(false);

	const dirty = draftChanged(draft, scope, verificationCommand);

	return (
		<FormStack
			onSubmit={(event) => {
				event.preventDefault();
				setConfirmed(false);
				onReviewIssue(draft.id, {
					scope: scope.trim(),
					verificationCommand: verificationCommand.trim(),
					evidence: draft.evidence,
				});
			}}
		>
			<div><Badge variant={draft.state === 'approved' ? 'success' : draft.state === 'stale' ? 'warning' : 'outline'}>{catalog.review.stateLabels[draft.state]}</Badge></div>
			<FormField className="text-sm" htmlFor="review-scope">
				<span className="font-medium">{catalog.form.scope}</span>
				<Textarea className="min-h-24" id="review-scope" onChange={(event) => setScope((event.currentTarget as unknown as { value: string }).value)} required value={scope} />
			</FormField>
			<FormField className="text-sm" htmlFor="review-command">
				<span className="font-medium">{catalog.form.verificationCommand}</span>
				<Input className="font-mono" id="review-command" onChange={(event) => setVerificationCommand((event.currentTarget as unknown as { value: string }).value)} required value={verificationCommand} />
			</FormField>
			{draft.evidence === undefined || draft.evidence.length === 0 ? null : (
				<div className="flex flex-col gap-2 text-sm">
					<span className="font-medium">{catalog.review.evidence}</span>
					<ul className="flex flex-col gap-2">
						{draft.evidence.map((item, index) => (
							<li className="flex flex-col gap-1" key={index}>
								<code className="break-all text-xs">{item.command}</code>
								<p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{item.output}</p>
							</li>
						))}
					</ul>
				</div>
			)}
			<button className={cn(BUTTON_CLASS, 'self-end')} disabled={pending || !dirty} type="submit">{catalog.review.saveRevision}</button>
			<label className="flex items-start gap-2 text-sm">
				<input checked={confirmed} disabled={pending || dirty} onChange={(event) => setConfirmed((event.currentTarget as unknown as { checked: boolean }).checked)} type="checkbox" />
				<span>{catalog.review.confirmPersisted}</span>
			</label>
			<button
				className={cn(PRIMARY_BUTTON_CLASS, 'self-end')}
				disabled={pending || dirty || !confirmed}
				onClick={() => { setConfirmed(false); onApproveIssue(draft.id); }}
				type="button"
			>{catalog.review.approve}</button>
			<FormField className="text-sm" htmlFor="abandon-reason">
				<span className="font-medium">{catalog.review.abandonReason}</span>
				<Textarea className="min-h-20" id="abandon-reason" onChange={(event) => setAbandonReason((event.currentTarget as unknown as { value: string }).value)} value={abandonReason} />
			</FormField>
			<label className="flex items-start gap-2 text-sm">
				<input checked={abandonConfirmed} disabled={pending || abandonReason.trim().length === 0} onChange={(event) => setAbandonConfirmed((event.currentTarget as unknown as { checked: boolean }).checked)} type="checkbox" />
				<span>{catalog.review.confirmAbandon(draft.id)}</span>
			</label>
			<button
				className={cn(BUTTON_CLASS, 'self-end')}
				disabled={pending || abandonReason.trim().length === 0 || !abandonConfirmed}
				onClick={() => {
					setAbandonConfirmed(false);
					onAbandonIssue(draft.id, abandonReason.trim());
				}}
				type="button"
			>{catalog.review.abandon}</button>
		</FormStack>
	);
}

export function IssueReviewPanel({
	catalog,
	drafts,
	locale,
	pending,
	runs,
	onReviewIssue,
	onApproveIssue,
	onAbandonIssue,
}: Pick<
	AppProps,
	'drafts' | 'locale' | 'pending' | 'runs' | 'onReviewIssue' | 'onApproveIssue' | 'onAbandonIssue'
> & { catalog: WorkCatalog }): React.ReactElement {
	const [selectedId, setSelectedId] = useState<string | null>(drafts[0]?.id ?? null);
	const selected = drafts.find((draft) => draft.id === selectedId) ?? null;
	// The run owns the issue file while it is in flight: revising, approving or
	// abandoning it would write on main what the ship closes on the run's branch.
	const ownedByRun = selected !== null && activeRunIssueId(runs) === selected.id;

	return (
		<CardDisclosure className="group">
			<CardSummary>
				<CardTitle>{catalog.review.title}</CardTitle>
				<CardDescription>{catalog.review.description(drafts.length, formatCount(drafts.length, locale))}</CardDescription>
				<CardAction><Badge variant="secondary">{formatCount(drafts.length, locale)}</Badge></CardAction>
			</CardSummary>
			<CardPanel>
				<label className="flex flex-col gap-1 text-sm" htmlFor="review-issue">
					<span className="font-medium">{catalog.review.draft}</span>
					<SelectField
						id="review-issue"
						items={[
							{ value: '', label: catalog.review.selectDraft },
							...drafts.map((draft) => ({ value: draft.id, label: `${draft.id} — ${draft.title}` })),
						]}
						onValueChange={(value) => setSelectedId(value === '' ? null : value)}
						value={selectedId ?? ''}
					/>
				</label>
				{selected === null || !ownedByRun ? null : (
					<p className="text-muted-foreground text-sm">
						{catalog.review.ownedByRun(selected.id)}
					</p>
				)}
				{selected === null || ownedByRun ? null : (
					<IssueReviewForm
						catalog={catalog}
						draft={selected}
						key={JSON.stringify([selected.id, selected.scope, selected.verificationCommand])}
						onAbandonIssue={onAbandonIssue}
						onApproveIssue={onApproveIssue}
						onReviewIssue={onReviewIssue}
						pending={pending}
					/>
				)}
			</CardPanel>
		</CardDisclosure>
	);
}

export function diagnosticFindingLocation(finding: DiagnosticFindingView): string {
	if (finding.line === undefined) return finding.file;
	return `${finding.file}:${finding.line}${finding.column === undefined ? '' : `:${finding.column}`}`;
}

export function diagnosticSeverityVariant(severity: DiagnosticFindingView['severity']): BadgeVariant {
	if (severity === 'error') return 'error';
	if (severity === 'warning') return 'warning';
	return 'info';
}

export function diagnosticScanVariant(
	state: NonNullable<DiagnosticsView['scan']>['state'],
): BadgeVariant {
	if (state === 'completed') return 'success';
	if (state === 'failed') return 'error';
	if (state === 'queued' || state === 'running') return 'info';
	return 'secondary';
}

export function DiagnosticScanSummary({
	catalog,
	scan,
}: Pick<DiagnosticsView, 'scan'> & { catalog: WorkCatalog['diagnostics'] }): React.ReactElement | null {
	if (scan === null) return null;
	return (
		<div className="flex flex-col gap-1 text-sm">
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant={diagnosticScanVariant(scan.state)}>{catalog.scanStateLabels[scan.state]}</Badge>
				{scan.sourceSha === null ? null : <code className="text-xs">{scan.sourceSha.slice(0, 12)}</code>}
				{scan.state === 'completed' && !scan.coverageComplete ? <Badge variant="warning">{catalog.partial}</Badge> : null}
			</div>
			{scan.error === null ? null : <p className="text-destructive-foreground">{scan.error}</p>}
		</div>
	);
}

export function DiagnosticFindingCard({
	catalog,
	finding,
	locale,
	pending,
	onDismiss,
	onPromote,
}: {
	finding: DiagnosticFindingView;
	catalog: WorkCatalog;
	locale: Locale;
	pending: boolean;
	onDismiss: AppProps['onDismissDiagnosticFinding'];
	onPromote: AppProps['onPromoteDiagnosticFinding'];
}): React.ReactElement {
	return (
		<details className="rounded-lg border border-border p-4 text-sm">
			<summary className="flex cursor-pointer list-none flex-wrap items-center gap-2">
				<Badge variant={diagnosticSeverityVariant(finding.severity)}>{catalog.diagnostics.severityLabels[finding.severity]}</Badge>
				<span className="font-semibold">{finding.rule}</span>
				{finding.occurrenceCount > 1 ? <Badge variant="outline">{catalog.diagnostics.occurrences(formatCount(finding.occurrenceCount, locale))}</Badge> : null}
				<code className="w-full break-all font-mono text-muted-foreground text-xs">{diagnosticFindingLocation(finding)}</code>
			</summary>
			<div className="mt-4 flex flex-col gap-4">
				<p className="whitespace-pre-wrap break-words text-muted-foreground">{finding.evidence}</p>
				<div className="flex flex-wrap items-center justify-between gap-2 font-mono text-muted-foreground text-xs">
					<span>{catalog.diagnostics.toolVersion(finding.toolVersion)}</span>
					<code>{finding.sourceSha.slice(0, 12)}</code>
				</div>
				<div className="flex justify-end">
					<Button disabled={pending} onClick={() => onDismiss(finding.id)} size="sm" type="button" variant="ghost">
						{catalog.diagnostics.dismiss}
					</Button>
				</div>
				<form
					className="flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						const value = fieldReader(event.currentTarget);
						onPromote(finding.id, {
							title: value('diagnosticTitle'),
							scope: value('diagnosticScope'),
							verificationCommand: value('diagnosticVerificationCommand'),
						});
					}}
				>
					<label className="flex flex-col gap-1">
						<span className="font-medium">{catalog.form.title}</span>
						<Input defaultValue={catalog.diagnostics.defaultIssueTitle(finding.rule, finding.file).slice(0, 120)} name="diagnosticTitle" required />
					</label>
					<label className="flex flex-col gap-1">
						<span className="font-medium">{catalog.form.scope}</span>
						<Textarea className="min-h-24" name="diagnosticScope" required />
					</label>
					<label className="flex flex-col gap-1">
						<span className="font-medium">{catalog.form.verificationCommand}</span>
						<Input className="font-mono" name="diagnosticVerificationCommand" placeholder={catalog.form.verificationPlaceholder} required />
					</label>
					<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">{catalog.form.promote}</button>
				</form>
			</div>
		</details>
	);
}

export function PendingDiagnosticFindings({
	catalog,
	findings,
	locale,
	pending,
	onDismiss,
	onPromote,
}: {
	findings: readonly DiagnosticFindingView[];
	catalog: WorkCatalog;
	locale: Locale;
	pending: boolean;
	onDismiss: AppProps['onDismissDiagnosticFinding'];
	onPromote: AppProps['onPromoteDiagnosticFinding'];
}): React.ReactElement {
	if (findings.length === 0) {
		return <EmptyState compact>{catalog.diagnostics.noPending}</EmptyState>;
	}
	return (
		<ul className="flex flex-col gap-3">
			{findings.map((finding) => (
				<li key={finding.id}>
					<DiagnosticFindingCard catalog={catalog} finding={finding} locale={locale} onDismiss={onDismiss} onPromote={onPromote} pending={pending} />
				</li>
			))}
		</ul>
	);
}

export function ResolvedDiagnosticFindings({
	catalog,
	findings,
	locale,
	omittedCount,
}: {
	findings: readonly DiagnosticFindingView[];
	catalog: WorkCatalog['diagnostics'];
	locale: Locale;
	omittedCount: number;
}): React.ReactElement {
	return (
		<details className="text-sm">
			<summary className="cursor-pointer text-muted-foreground">{catalog.resolved(formatCount(findings.length, locale))}</summary>
			<ul className="mt-3 flex flex-col gap-2">
				{findings.map((finding) => (
					<li className="flex flex-wrap items-center gap-2" key={finding.id}>
						<Badge variant="secondary">{catalog.statusLabels[finding.status]}</Badge>
						<span>{finding.rule}</span>
						<code className="break-all text-xs text-muted-foreground">{diagnosticFindingLocation(finding)}</code>
						{finding.promotedIssueId === null ? null : <Badge variant="info">{finding.promotedIssueId}</Badge>}
					</li>
				))}
			</ul>
			{omittedCount > 0 ? <p className="mt-2 text-muted-foreground">{catalog.omitted(formatCount(omittedCount, locale))}</p> : null}
		</details>
	);
}

export function DiagnosticOutcomeSummary({
	catalog,
	locale,
	stats,
}: Pick<DiagnosticsView, 'stats'> & { catalog: WorkCatalog['diagnostics']; locale: Locale }): React.ReactElement {
	if (stats.total === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				{catalog.noHistory}
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-1 text-sm">
			<p>
				{catalog.history(
					formatCount(stats.promoted, locale),
					formatCount(stats.dismissed, locale),
					formatCount(stats.cleared, locale),
					formatCount(stats.pending, locale),
				)}
			</p>
			{stats.recurring === 0 ? null : (
				<p className="text-muted-foreground">{catalog.recurring(stats.recurring, formatCount(stats.recurring, locale))}</p>
			)}
			<p className="text-muted-foreground text-xs">
				{catalog.dismissalDisclaimer}
			</p>
		</div>
	);
}

/**
 * One optional, advisory analyzer at a time. The summary stays compact; raw
 * evidence and issue promotion live behind per-finding disclosure.
 */
export function DiagnosticsPanel({
	catalog,
	diagnostics,
	locale,
	pending,
	onStartDiagnostic,
	onCancelDiagnostic,
	onDismissDiagnosticFinding,
	onPromoteDiagnosticFinding,
}: Pick<
	AppProps,
	| 'diagnostics'
	| 'pending'
	| 'onStartDiagnostic'
	| 'onCancelDiagnostic'
	| 'onDismissDiagnosticFinding'
	| 'onPromoteDiagnosticFinding'
	| 'locale'
> & { catalog: WorkCatalog }): React.ReactElement {
	const scan = diagnostics.scan;
	const active = scan?.state === 'queued' || scan?.state === 'running';
	const analyzer = diagnostics.analyzers[0];
	return (
		<CardDisclosure className="group">
			<CardSummary>
				<CardTitle>{catalog.diagnostics.title}</CardTitle>
				<CardDescription>
					{active ? catalog.diagnostics.analyzing : catalog.diagnostics.pendingCount(diagnostics.findings.length, formatCount(diagnostics.findings.length, locale))}
				</CardDescription>
				<CardAction><Badge variant={active ? 'info' : 'secondary'}>{active ? catalog.diagnostics.running : formatCount(diagnostics.findings.length, locale)}</Badge></CardAction>
			</CardSummary>
			<CardPanel>
				<div className="flex flex-col gap-2 text-sm">
					<p className="text-muted-foreground">
						{catalog.diagnostics.advisory}
					</p>
					{analyzer === undefined ? null : (
						<div className="flex flex-wrap items-center gap-2">
							<Badge variant="outline">{analyzer.label}</Badge>
							<code className="text-xs">v{analyzer.version}</code>
							<span className="text-muted-foreground">
								{analyzer.id === 'react'
									? catalog.diagnostics.analyzerDescriptions.react
									: analyzer.description}
							</span>
						</div>
					)}
				</div>
				<DiagnosticScanSummary catalog={catalog.diagnostics} scan={scan} />
				<div className="flex flex-wrap gap-2">
					{!active && analyzer !== undefined ? (
						<ActionButton
							enabled={!pending}
							label={catalog.diagnostics.runNow}
							onClick={() => onStartDiagnostic(analyzer.id)}
						/>
					) : null}
					{active && scan !== null ? (
						<ActionButton
							enabled={!pending}
							label={catalog.diagnostics.cancel}
							onClick={() => onCancelDiagnostic(scan.id)}
						/>
					) : null}
				</div>
				{diagnostics.workspaceNotices.map((notice) => (
					<p className="text-warning-foreground text-sm" key={notice}>{notice}</p>
				))}
				<DiagnosticOutcomeSummary catalog={catalog.diagnostics} locale={locale} stats={diagnostics.stats} />
				<Separator />
				<PendingDiagnosticFindings
					catalog={catalog}
					findings={diagnostics.findings}
					locale={locale}
					onDismiss={onDismissDiagnosticFinding}
					onPromote={onPromoteDiagnosticFinding}
					pending={pending}
				/>
				<ResolvedDiagnosticFindings
					catalog={catalog.diagnostics}
					findings={diagnostics.resolvedFindings}
					locale={locale}
					omittedCount={diagnostics.resolvedFindingsOmittedCount}
				/>
			</CardPanel>
		</CardDisclosure>
	);
}

/**
 * The inbox of ideas the runs found outside their issue: the evidence exactly
 * as it was captured, and the two decisions it admits. Discarding writes
 * nothing else; promoting files a new task with the contract the operator
 * authors here, pre-filled with the proposal's own title and never approved or
 * started by this screen. A settled proposal leaves the list.
 */
export function ProposalsPanel({
	catalog,
	locale,
	proposals,
	pending,
	onDismissProposal,
	onPromoteProposal,
}: Pick<
	AppProps,
	'locale' | 'proposals' | 'pending' | 'onDismissProposal' | 'onPromoteProposal'
> & { catalog: WorkCatalog }): React.ReactElement {
	return (
		<CardDisclosure className="group">
			<CardSummary>
				<CardTitle>{catalog.proposals.pendingTitle}</CardTitle>
				<CardDescription>{catalog.proposals.pendingCount(proposals.length, formatCount(proposals.length, locale))}</CardDescription>
				<CardAction><Badge variant="secondary">{formatCount(proposals.length, locale)}</Badge></CardAction>
			</CardSummary>
			<CardPanel>
				{proposals.length === 0 ? (
					<EmptyState compact>{catalog.proposals.emptyPending}</EmptyState>
				) : (
					<ul className="flex flex-col divide-y divide-border">
						{proposals.map((proposal) => (
							<li className="flex min-w-0 flex-col gap-3 py-5 text-sm first:pt-0 last:pb-0" key={proposal.id}>
								<div className="flex items-start justify-between gap-3">
									<div className="flex min-w-0 flex-col gap-1.5">
										<span className="break-words font-semibold">{proposal.title}</span>
										<div className="flex flex-wrap items-center gap-2 text-muted-foreground">
											<Badge variant="outline">{proposal.sourceIssueId}</Badge>
											<code className="break-all text-xs">{proposal.sourceRunId}</code>
										</div>
									</div>
									<Button
										disabled={pending}
										onClick={() => onDismissProposal(proposal.id)}
										size="sm"
										type="button"
										variant="ghost"
									>
										{catalog.proposals.dismiss}
									</Button>
								</div>
								<p className="whitespace-pre-wrap break-words text-muted-foreground">
									{proposal.evidence}
								</p>
								{/* Forty of these live on one tab: the promote form discloses
								 * per item instead of stacking three fields forty times. */}
								<details>
									<summary className="w-fit cursor-pointer text-muted-foreground text-sm hover:text-foreground">
										{catalog.form.promote}
									</summary>
								<form
									className="mt-3 flex flex-col gap-3"
									onSubmit={(event) => {
										event.preventDefault();
										const value = fieldReader(event.currentTarget);
										onPromoteProposal(proposal.id, {
											title: value('proposalTitle'),
											scope: value('proposalScope'),
											verificationCommand: value('proposalVerificationCommand'),
										});
									}}
								>
									<label
										className="flex flex-col gap-1"
										htmlFor={`proposal-title-${proposal.id}`}
									>
										<span className="font-medium">{catalog.form.title}</span>
										<Input
															defaultValue={proposal.title}
											id={`proposal-title-${proposal.id}`}
											name="proposalTitle"
											required
										/>
									</label>
									<label
										className="flex flex-col gap-1"
										htmlFor={`proposal-scope-${proposal.id}`}
									>
										<span className="font-medium">{catalog.form.scope}</span>
										<Textarea
											className="min-h-24"
											id={`proposal-scope-${proposal.id}`}
											name="proposalScope"
											required
										/>
									</label>
									<label
										className="flex flex-col gap-1"
										htmlFor={`proposal-command-${proposal.id}`}
									>
										<span className="font-medium">{catalog.form.verificationCommand}</span>
										<Input
											className="font-mono"
											id={`proposal-command-${proposal.id}`}
											name="proposalVerificationCommand"
											placeholder={catalog.form.verificationPlaceholder}
											required
										/>
									</label>
									<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
										{catalog.form.promote}
									</button>
								</form>
								</details>
							</li>
						))}
					</ul>
				)}
			</CardPanel>
		</CardDisclosure>
	);
}

/**
 * What a settled proposal became, read-only: a dismissed one stays a
 * discarded idea, a promoted one names the issue it turned into (GSHIP-643).
 * Separate from `ProposalsPanel` above so the pending inbox is never mixed
 * with this historical record, and offers no decision -- no undo, no
 * re-promotion -- only the outcome.
 */
export function ResolvedProposalsPanel({
	catalog,
	locale,
	resolvedProposals,
	resolvedProposalsOmittedCount,
}: Pick<AppProps, 'locale' | 'resolvedProposals' | 'resolvedProposalsOmittedCount'> & { catalog: WorkCatalog }): React.ReactElement {
	return (
		<CardDisclosure className="group">
			<CardSummary>
				<CardTitle>{catalog.proposals.resolvedTitle}</CardTitle>
				<CardDescription>{catalog.proposals.resolvedCount(resolvedProposals.length, formatCount(resolvedProposals.length, locale))}</CardDescription>
				<CardAction><Badge variant="secondary">{formatCount(resolvedProposals.length, locale)}</Badge></CardAction>
			</CardSummary>
			<CardPanel>
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant="outline">{catalog.proposals.readOnly}</Badge>
					<span className="text-muted-foreground text-sm">
						{catalog.proposals.settledNote}
					</span>
				</div>
				<Separator />
				{resolvedProposals.length === 0 ? (
					<EmptyState compact>{catalog.proposals.emptyResolved}</EmptyState>
				) : (
					<ul className="flex flex-col divide-y divide-border">
						{resolvedProposals.map((proposal) => (
							<li className="flex min-w-0 flex-col gap-2 py-4 text-sm first:pt-0 last:pb-0" key={proposal.id}>
								<div className="flex flex-wrap items-center gap-2">
									<span className="break-words font-semibold">{proposal.title}</span>
									{proposal.status === 'promoted' ? (
										<Badge variant="success">{catalog.proposals.statusLabels.promoted}</Badge>
									) : (
										<Badge variant="secondary">{catalog.proposals.statusLabels.dismissed}</Badge>
									)}
								</div>
								<p className="whitespace-pre-wrap break-words text-muted-foreground">
									{proposal.evidence}
								</p>
								<div className="flex flex-wrap items-center gap-2 text-muted-foreground">
									<Badge variant="outline">{proposal.sourceIssueId}</Badge>
									<code className="break-all text-xs">{proposal.sourceRunId}</code>
									{proposal.status === 'promoted' && proposal.promotedIssueId !== null ? (
										<span className="break-words">
											{catalog.proposals.became} <Badge variant="info">{proposal.promotedIssueId}</Badge>
										</span>
									) : null}
								</div>
							</li>
						))}
					</ul>
				)}
				{resolvedProposalsOmittedCount > 0 ? (
					<p className="text-muted-foreground text-sm">
						{catalog.proposals.omitted(resolvedProposalsOmittedCount, formatCount(resolvedProposalsOmittedCount, locale))}
					</p>
				) : null}
			</CardPanel>
		</CardDisclosure>
	);
}

/**
 * Work is four operator questions, one visible at a time (the panels
 * themselves are unchanged from GSHIP-712; only the disclosure is new):
 * what is ready to run (queue), what waits on my approval (the only tab whose
 * count may go acid, because approval is the operator's turn), what is still
 * an idea (specify and intake), and what does the system suggest
 * (diagnostics, boot-runtime-only, and the project-scoped proposal inbox with
 * its resolved history). Panels stay mounted behind their tabs so
 * find-in-page and static rendering keep seeing the whole surface. The
 * surface opens on approval when something actually waits there.
 */
export function WorkSurface(props: AppProps): React.ReactElement {
	const localeCatalog = LOCALE_CATALOG[props.locale];
	const catalog = localeCatalog.work;
	const failed = (resource: keyof NonNullable<typeof props.operationalFailures>): string | undefined => props.operationalFailures?.[resource];
	const loaded = (resource: keyof NonNullable<typeof props.operationalLoaded>): boolean => props.operationalLoaded?.[resource] === true;
	const pending = (resource: keyof NonNullable<typeof props.operationalPending>): boolean => props.operationalPending?.[resource] === true;
	const unavailableInitially = (resource: keyof NonNullable<typeof props.operationalFailures>): boolean =>
		(failed(resource) !== undefined || pending(resource)) && !loaded(resource);
	const runsUnavailableInitially = unavailableInitially('Runs');
	const knownRuns = runsUnavailableInitially ? [] : props.runs;
	const actions = actionsFor(knownRuns[0] ?? null, props.selectedIssueId !== null);
	const runsUnavailable = failed('Runs');
	const reviewActionsDisabled = props.pending || runsUnavailableInitially;
	return (
		<SurfaceColumn label={localeCatalog.shell.routeLabels.work} status={props.status}>
			<Tabs defaultValue={props.drafts.length > 0 ? 'approval' : 'queue'}>
				<TabsList aria-label={localeCatalog.shell.routeLabels.work}>
					<TabsTab value="queue">
						{catalog.tabs.queue}
						<TabsCount>{unavailableInitially('Snapshot') ? '—' : props.backlog.length}</TabsCount>
					</TabsTab>
					<TabsTab value="approval">
						{catalog.tabs.approval}
						<TabsCount attention={!unavailableInitially('Snapshot') && props.drafts.length > 0}>{unavailableInitially('Snapshot') ? '—' : props.drafts.length}</TabsCount>
					</TabsTab>
					<TabsTab value="ideas">
						{catalog.tabs.ideas}
						<TabsCount>{unavailableInitially('Snapshot') ? '—' : props.ideas.length}</TabsCount>
					</TabsTab>
					<TabsTab value="suggestions">
						{catalog.tabs.suggestions}
						<TabsCount>{unavailableInitially('Proposals') ? '—' : props.proposals.length}</TabsCount>
					</TabsTab>
				</TabsList>
				<TabsPanel value="queue">
					<OperationalReadPanel detail={runsUnavailable} loaded={loaded('Runs')} locale={props.locale} pending={pending('Runs')} resource="Runs"><span /></OperationalReadPanel>
					<OperationalReadPanel detail={failed('Snapshot')} loaded={loaded('Snapshot')} locale={props.locale} pending={pending('Snapshot')} resource="Snapshot"><BacklogPanel
						backlog={props.backlog}
						canStart={actions.start && !reviewActionsDisabled}
						catalog={catalog.backlog}
						locale={props.locale}
						onSelectIssue={props.onSelectIssue}
						onStart={props.onStart}
						selectedIssueId={props.selectedIssueId}
					/></OperationalReadPanel>
				</TabsPanel>
				<TabsPanel value="approval">
					<OperationalReadPanel detail={runsUnavailable} loaded={loaded('Runs')} locale={props.locale} pending={pending('Runs')} resource="Runs"><span /></OperationalReadPanel>
					<OperationalReadPanel detail={failed('Snapshot')} loaded={loaded('Snapshot')} locale={props.locale} pending={pending('Snapshot')} resource="Snapshot"><IssueReviewPanel catalog={catalog} drafts={props.drafts} locale={props.locale} onAbandonIssue={props.onAbandonIssue} onApproveIssue={props.onApproveIssue} onReviewIssue={props.onReviewIssue} pending={reviewActionsDisabled} runs={knownRuns} /></OperationalReadPanel>
				</TabsPanel>
				<TabsPanel value="ideas">
					<OperationalReadPanel detail={failed('Snapshot')} loaded={loaded('Snapshot')} locale={props.locale} pending={pending('Snapshot')} resource="Snapshot"><IssueSpecifyPanel
						catalog={catalog}
						ideas={props.ideas}
						onSpecifyIssue={props.onSpecifyIssue}
						pending={props.pending}
					/></OperationalReadPanel>
					<IssueIntakePanel catalog={catalog} onCreateIssue={props.onCreateIssue} pending={props.pending} />
				</TabsPanel>
				<TabsPanel value="suggestions">
					<OperationalReadPanel detail={failed('Diagnostics')} loaded={loaded('Diagnostics')} locale={props.locale} pending={pending('Diagnostics')} resource="Diagnostics"><DiagnosticsPanel
						catalog={catalog}
						diagnostics={props.diagnostics}
						locale={props.locale}
						onCancelDiagnostic={props.onCancelDiagnostic}
						onDismissDiagnosticFinding={props.onDismissDiagnosticFinding}
						onPromoteDiagnosticFinding={props.onPromoteDiagnosticFinding}
						onStartDiagnostic={props.onStartDiagnostic}
						pending={props.pending}
					/></OperationalReadPanel>
					<OperationalReadPanel detail={failed('Proposals')} loaded={loaded('Proposals')} locale={props.locale} pending={pending('Proposals')} resource="Proposals"><ProposalsPanel
						catalog={catalog}
						locale={props.locale}
						onDismissProposal={props.onDismissProposal}
						onPromoteProposal={props.onPromoteProposal}
						pending={props.pending}
						proposals={props.proposals}
					/></OperationalReadPanel>
					<OperationalReadPanel detail={failed('Resolved proposals')} loaded={loaded('Resolved proposals')} locale={props.locale} pending={pending('Resolved proposals')} resource="Resolved proposals"><ResolvedProposalsPanel
						catalog={catalog}
						locale={props.locale}
						resolvedProposals={props.resolvedProposals}
						resolvedProposalsOmittedCount={props.resolvedProposalsOmittedCount}
					/></OperationalReadPanel>
				</TabsPanel>
			</Tabs>
		</SurfaceColumn>
	);
}
