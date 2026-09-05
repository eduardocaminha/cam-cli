// webui/src/screens/settings-screen.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../components/ui/tabs.tsx';
import { LOCALE_CATALOG } from '../locale.ts';
import { SurfaceColumn } from './surface-column.tsx';
import { OperationalReadPanel } from '../operational-unavailable.tsx';
import { ChainRunsPanel, DiagnosticSchedulePanel, ExecutorHandoffPanel, ModelSettingsPanel, ProjectBriefPanel, ProjectPanel, ProvidersPanel } from './settings.tsx';

export function SettingsSurface(props: AppProps & { removePanel?: React.ReactNode }): React.ReactElement {
	const catalog = LOCALE_CATALOG[props.locale].settings;
	const failed = (resource: keyof NonNullable<typeof props.operationalFailures>): string | undefined => props.operationalFailures?.[resource];
	const loaded = (resource: keyof NonNullable<typeof props.operationalLoaded>): boolean => props.operationalLoaded?.[resource] === true;
	const pending = (resource: keyof NonNullable<typeof props.operationalPending>): boolean => props.operationalPending?.[resource] === true;
	return (
		<SurfaceColumn label={catalog.title} status={props.status}>
			<Tabs defaultValue="providers">
				<TabsList>
					<TabsTab value="providers">{catalog.tabs.providers}</TabsTab>
					<TabsTab value="execution">{catalog.tabs.execution}</TabsTab>
					<TabsTab value="project">{catalog.tabs.project}</TabsTab>
				</TabsList>
				<TabsPanel value="providers">
					<OperationalReadPanel detail={failed('Providers')} loaded={loaded('Providers')} locale={props.locale} pending={pending('Providers')} resource="Providers"><ProvidersPanel
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
					/></OperationalReadPanel>
					<OperationalReadPanel detail={failed('Model settings')} loaded={loaded('Model settings')} locale={props.locale} pending={pending('Model settings')} resource="Model settings"><ModelSettingsPanel
						catalog={catalog}
						modelSettings={props.modelSettings}
						modelSettingsSource={props.modelSettingsSource}
						onSaveModelSettings={props.onSaveModelSettings}
						onResetModelSettings={props.onResetModelSettings}
						pending={props.pending}
					/></OperationalReadPanel>
				</TabsPanel>
				<TabsPanel value="execution">
					<OperationalReadPanel detail={failed('Run chain')} loaded={loaded('Run chain')} locale={props.locale} pending={pending('Run chain')} resource="Run chain"><ChainRunsPanel
						catalog={catalog}
						chainRuns={props.chainRuns}
						onSetChainRuns={props.onSetChainRuns}
						pending={props.pending}
					/></OperationalReadPanel>
					<OperationalReadPanel detail={failed('Executor handoff')} loaded={loaded('Executor handoff')} locale={props.locale} pending={pending('Executor handoff')} resource="Executor handoff"><ExecutorHandoffPanel
						catalog={catalog}
						executorHandoff={props.executorHandoff}
						onSetExecutorHandoff={props.onSetExecutorHandoff}
						pending={props.pending}
					/></OperationalReadPanel>
					{props.project.state === 'ready' ? (
						<OperationalReadPanel detail={failed('Diagnostics')} loaded={loaded('Diagnostics')} locale={props.locale} pending={pending('Diagnostics')} resource="Diagnostics"><DiagnosticSchedulePanel
							catalog={catalog}
							diagnostics={props.diagnostics}
							locale={props.locale}
							onSave={props.onSaveDiagnosticSchedule}
							pending={props.pending}
						/></OperationalReadPanel>
					) : null}
				</TabsPanel>
				<TabsPanel value="project">
					<ProjectPanel catalog={catalog} project={props.project} />
					<OperationalReadPanel detail={failed('Brief')} loaded={loaded('Brief')} locale={props.locale} pending={pending('Brief')} resource="Brief"><ProjectBriefPanel
						brief={props.brief}
						catalog={catalog}
						onSaveBrief={props.onSaveBrief}
						pending={props.pending}
					/></OperationalReadPanel>
					{props.removePanel}
				</TabsPanel>
			</Tabs>
		</SurfaceColumn>
	);
}
