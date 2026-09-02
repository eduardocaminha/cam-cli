// webui/src/screens/settings-screen.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../components/ui/tabs.tsx';
import { LOCALE_CATALOG } from '../locale.ts';
import { SurfaceColumn } from './surface-column.tsx';
import { ChainRunsPanel, DiagnosticSchedulePanel, ExecutorHandoffPanel, HandoffPanel, ModelSettingsPanel, ProjectBriefPanel, ProjectPanel, ProvidersPanel } from './settings.tsx';

export function SettingsSurface(props: AppProps & { removePanel?: React.ReactNode }): React.ReactElement {
	const catalog = LOCALE_CATALOG[props.locale].settings;
	return (
		<SurfaceColumn label={catalog.title} status={props.status}>
			<Tabs defaultValue="providers">
				<TabsList>
					<TabsTab value="providers">{catalog.tabs.providers}</TabsTab>
					<TabsTab value="execution">{catalog.tabs.execution}</TabsTab>
					<TabsTab value="project">{catalog.tabs.project}</TabsTab>
				</TabsList>
				<TabsPanel value="providers">
					<ProvidersPanel
						catalog={catalog}
						claudeCredentialError={props.claudeCredentialError}
						locale={props.locale}
						onConnectClaudeCredential={props.onConnectClaudeCredential}
						onConnectCodex={props.onConnectCodex}
						onDisconnectClaudeCredential={props.onDisconnectClaudeCredential}
						onDismissClaudeCredentialError={props.onDismissClaudeCredentialError}
						onSelectProvider={props.onSelectProvider}
						pending={props.pending}
						providers={props.providers}
						providerSource={props.providerSource}
						onResetProvider={props.onResetProvider}
						selectedProvider={props.selectedProvider}
					/>
					<ModelSettingsPanel
						catalog={catalog}
						modelSettings={props.modelSettings}
						modelSettingsSource={props.modelSettingsSource}
						onSaveModelSettings={props.onSaveModelSettings}
						onResetModelSettings={props.onResetModelSettings}
						pending={props.pending}
					/>
				</TabsPanel>
				<TabsPanel value="execution">
					<ChainRunsPanel
						catalog={catalog}
						chainRuns={props.chainRuns}
						onSetChainRuns={props.onSetChainRuns}
						pending={props.pending}
					/>
					<ExecutorHandoffPanel
						catalog={catalog}
						executorHandoff={props.executorHandoff}
						onSetExecutorHandoff={props.onSetExecutorHandoff}
						pending={props.pending}
					/>
					{props.project.state === 'ready' ? (
						<DiagnosticSchedulePanel
							catalog={catalog}
							diagnostics={props.diagnostics}
							locale={props.locale}
							onSave={props.onSaveDiagnosticSchedule}
							pending={props.pending}
						/>
					) : null}
				</TabsPanel>
				<TabsPanel value="project">
					<ProjectPanel catalog={catalog} project={props.project} />
					<ProjectBriefPanel
						brief={props.brief}
						catalog={catalog}
						onSaveBrief={props.onSaveBrief}
						pending={props.pending}
					/>
					<HandoffPanel catalog={catalog} handoff={props.handoff} />
					{props.removePanel}
				</TabsPanel>
			</Tabs>
		</SurfaceColumn>
	);
}
