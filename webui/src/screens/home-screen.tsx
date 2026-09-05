// webui/src/screens/home-screen.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import { INSPECTOR_COLUMN_CLASS } from '../app-shell.tsx';
import { LOCALE_CATALOG } from '../locale.ts';
import { ConversationColumn } from './conversation.tsx';
import { TEXT_LINK_CLASS } from './operator-links.ts';
import { RunCard } from './runs.tsx';

export function HomeSurface(props: AppProps & { inspectorOpen: boolean; projectId: string }): React.ReactElement {
	const run = props.runs[0] ?? null;
	const localeCatalog = LOCALE_CATALOG[props.locale];
	return (
		<div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:overflow-hidden" data-slot="conversation-layout">
			<ConversationColumn
				catalog={localeCatalog.conversation}
				chatMessages={props.chatMessages}
				operationalFailures={props.operationalFailures}
				operationalLoaded={props.operationalLoaded}
				locale={props.locale}
				onResume={props.onResume}
				onSendMessage={props.onSendMessage}
				pending={props.pending}
				run={run}
				status={props.status}
			/>
			{props.inspectorOpen ? <aside
				aria-label={localeCatalog.runInspector.homeAccessibleLabel}
				className={`flex w-full min-w-0 flex-col gap-6 p-4 pt-0 lg:p-6 lg:pt-0 ${INSPECTOR_COLUMN_CLASS} xl:overflow-y-auto xl:pt-6`}
				data-slot="run-inspector"
			>
				<RunCard
					catalog={localeCatalog.runInspector}
					footer={
						<a className={TEXT_LINK_CLASS} href={`/projects/${encodeURIComponent(props.projectId)}/runs`}>
							{localeCatalog.runInspector.viewDetailsLabel}
						</a>
					}
					locale={props.locale}
					onAbandon={props.onAbandon}
					onCancel={props.onCancel}
					onResume={props.onResume}
					onShip={props.onShip}
					pending={props.pending}
					run={run}
					title={localeCatalog.runInspector.currentRunTitle}
				/>
			</aside> : null}
		</div>
	);
}
