// webui/src/screens/conversation.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import { MAIN_CONTENT_ID } from '../app-shell.tsx';
import { aggregateChatTurnCosts } from '../client.ts';
import { AttentionCard } from '../components/ui/attention-card.tsx';
import { Button } from '../components/ui/button.tsx';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '../components/ui/card.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { cn } from '../lib/cn.ts';
import { useLiveEdge } from '../live-edge.ts';
import type { ConversationCatalog, Locale } from '../locale.ts';
import type { RunView } from '../run-view.ts';
import { PRIMARY_BUTTON_CLASS } from './operator-controls.tsx';
import { fieldReader, formatCostUsd, formatEventTime } from './runs.tsx';

export function ChatLog({
	chatMessages,
	catalog,
	locale,
}: Pick<AppProps, 'chatMessages'> & { catalog: ConversationCatalog; locale: Locale }): React.ReactElement {
	const liveEdge = useLiveEdge(chatMessages.at(-1)?.seq ?? null);
	return (
		<section
			{...liveEdge}
			aria-label={catalog.transcriptLabel}
			className="min-h-24 min-w-0 overflow-x-hidden overflow-y-visible rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring xl:flex-1 xl:overflow-y-auto"
		>
			{chatMessages.length === 0 ? (
				<EmptyState>{catalog.emptyStateGuidance}</EmptyState>
			) : (
				<ol className="flex flex-col gap-4">
					{chatMessages.map((message) => {
						if (message.role === 'system') {
							return (
								<li className="flex items-center gap-3 py-0.5 text-muted-foreground text-xs" key={message.seq}>
									<span aria-hidden="true" className="h-px min-w-6 flex-1 bg-border" />
									<span className="max-w-[75%] whitespace-pre-wrap break-words text-center">
										{message.text}
									</span>
									<span aria-hidden="true" className="h-px min-w-6 flex-1 bg-border" />
								</li>
							);
						}
						const operator = message.role === 'operator';
						return (
							<li
								className={cn('flex min-w-0 flex-col gap-1', operator && 'items-end')}
								key={message.seq}
							>
								<div className="flex items-baseline gap-2 text-muted-foreground text-xs">
									<span className="font-medium">
										{operator ? catalog.roleLabels.operator : catalog.roleLabels.orchestrator}
									</span>
									<span className="font-mono text-[10px]">{message.providerId}</span>
									<time className="font-mono text-[10px]">
										{formatEventTime(message.createdAt, locale)}
									</time>
								</div>
								{operator ? (
									<p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border bg-secondary px-3.5 py-2.5 text-sm">
										{message.text}
									</p>
								) : (
									<p className="max-w-[92%] whitespace-pre-wrap break-words text-sm leading-relaxed">
										{message.text}
									</p>
								)}
							</li>
						);
					})}
				</ol>
			)}
		</section>
	);
}

/**
 * The expected cost across every orchestrator turn the transcript carries a
 * usage event for (GSHIP-634) -- the same label the run cards use, since the
 * operator pays one subscription for both. A turn that never reported usage
 * contributes nothing and is not counted in the turns it covers; hidden
 * entirely when no turn ever reported one, the same absence-over-zero rule
 * the run cost summary already follows.
 */
export function ChatCostSummary({
	chatMessages,
	catalog,
	locale,
}: Pick<AppProps, 'chatMessages' | 'locale'> & {
	catalog: ConversationCatalog;
}): React.ReactElement | null {
	const aggregate = aggregateChatTurnCosts(chatMessages);
	if (aggregate.totalCostUsd === null) return null;
	return (
		<p className="text-muted-foreground text-sm">
			{catalog.costSummary(aggregate.turnCount, formatCostUsd(aggregate.totalCostUsd, locale))}
		</p>
	);
}

/**
 * The run's own question, asked where the operator is already answering. It
 * only exists while the runtime is holding for a decision, and resuming is the
 * one run command that belongs on the conversation surface.
 */
export function OperatorAnswer({
	run,
	pending,
	onResume,
	catalog,
}: Pick<AppProps, 'pending' | 'onResume'> & {
	run: RunView | null;
	catalog: ConversationCatalog;
}): React.ReactElement | null {
	if (run === null || run.state !== 'waiting-user') return null;
	return (
		<AttentionCard title={catalog.waitingDecisionPrompt}>
			{run.summary === null ? null : (
				<p className="whitespace-pre-wrap break-words text-muted-foreground text-sm">
					{run.summary}
				</p>
			)}
			<form
				className="flex flex-col gap-2"
				key={run.updatedAt}
				onSubmit={(event) => {
					event.preventDefault();
					onResume(fieldReader(event.currentTarget)('operatorGuidance'));
				}}
			>
				<label className="font-medium text-sm" htmlFor="operator-guidance">
					{catalog.response.label}
				</label>
				<Textarea
					disabled={pending}
					id="operator-guidance"
					name="operatorGuidance"
					placeholder={catalog.response.placeholder}
					required
					rows={3}
				/>
				<Button disabled={pending} type="submit" variant="attention">
					{catalog.response.button}
				</Button>
			</form>
		</AttentionCard>
	);
}

/** The last command outcome, announced wherever the command was issued. */
export function StatusOutput({ status }: Pick<AppProps, 'status'>): React.ReactElement | null {
	if (status === null) return null;
	return (
		<output aria-live="polite" className="break-words text-muted-foreground text-sm">
			{status}
		</output>
	);
}

/**
 * The primary surface: the durable conversation, whatever the run is asking
 * right now, the last command outcome, and the composer -- in the order the
 * operator reads them, and filling the column on a wide viewport.
 */
export function ConversationColumn({
	run,
	chatMessages,
	status,
	pending,
	onResume,
	onSendMessage,
	locale,
	catalog,
}: Pick<AppProps, 'chatMessages' | 'status' | 'pending' | 'onResume' | 'onSendMessage'> & {
	run: RunView | null;
	locale: Locale;
	catalog: ConversationCatalog;
}): React.ReactElement {
	return (
		<main
			className="flex w-full min-w-0 shrink-0 flex-col p-4 lg:p-6 xl:min-h-0 xl:flex-1 xl:shrink"
			id={MAIN_CONTENT_ID}
			tabIndex={-1}
		>
			<Card className="mx-auto flex w-full max-w-(--content-measure) flex-col xl:min-h-0 xl:flex-1">
				<CardHeader>
					<CardTitle>{catalog.title}</CardTitle>
					<CardDescription>{catalog.description}</CardDescription>
				</CardHeader>
				<CardPanel className="flex flex-col gap-4 xl:min-h-0 xl:flex-1">
					<ChatLog catalog={catalog} chatMessages={chatMessages} locale={locale} />
					<ChatCostSummary catalog={catalog} chatMessages={chatMessages} locale={locale} />
					<OperatorAnswer catalog={catalog} onResume={onResume} pending={pending} run={run} />
					<StatusOutput status={status} />
					<form
						className="flex gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							const form = event.currentTarget as unknown as { reset: () => void };
							const value = fieldReader(event.currentTarget)('message');
							if (value.length > 0) {
								onSendMessage(value);
								form.reset();
							}
						}}
					>
						<label className="sr-only" htmlFor="orchestrator-message">
							{catalog.composer.label}
						</label>
						<Textarea
							className="max-h-40 min-w-0"
							disabled={pending}
							id="orchestrator-message"
							name="message"
							onKeyDown={(event) => {
								if (event.key === 'Enter' && !event.shiftKey) {
									event.preventDefault();
									// Same idiom as the reset() cast below: the root tsconfig
									// checks this file without the DOM lib.
									const field = event.currentTarget as unknown as {
										closest: (selector: string) => { requestSubmit: () => void } | null;
									};
									field.closest('form')?.requestSubmit();
								}
							}}
							placeholder={catalog.composer.placeholder}
							required
							rows={1}
						/>
						<button className={cn(PRIMARY_BUTTON_CLASS, 'self-end')} disabled={pending} type="submit">
							{catalog.composer.button}
						</button>
					</form>
				</CardPanel>
			</Card>
		</main>
	);
}
