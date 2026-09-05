// webui/src/App.tsx
//
// The application entry point stays deliberately narrow. Route surfaces are
// implemented under screens so this module remains the stable public boundary.

import React, { useEffect } from 'react';
import type { AppProps } from './app-props.ts';
import { AppShell } from './app-shell.tsx';
import { InitialOperationalFailure, InitialOperationalLoading, OperationalRefreshFailure } from './initial-loading.tsx';
import { LOCALE_CATALOG } from './locale.ts';
import { routeSelection } from './routes.ts';
import { RouteScreen } from './screens/route-screen.tsx';
import { SurfaceColumn } from './screens/surface-column.tsx';
import { GlobalSettingsSurface } from './screens/global-settings-screen.tsx';
import { NonCurrentProjectSurface } from './screens/non-current-project-screen.tsx';
import { OnboardingSurface } from './screens/onboarding-screen.tsx';
import { OverviewSurface } from './screens/overview-screen.tsx';
import { ProjectsManagementSurface } from './screens/projects-management-screen.tsx';
import { RunsSurface } from './screens/runs-screen.tsx';
import { SettingsSurface } from './screens/settings-screen.tsx';
import {
	panelRuntime,
	type PanelKeyEvent,
	ShellControls,
	ShellSidebar,
	useStoredOpen,
} from './screens/shell.tsx';
import { WorkSurface } from './screens/work-screen.tsx';

export { projectIdOf, routeOf } from './routes.ts';
export type { AppProps } from './app-props.ts';
export type { OperatorRoute } from './routes.ts';

export function handleProjectShortcut(
	event: PanelKeyEvent,
	projects: AppProps['projects'],
	runtime = panelRuntime(),
	navigate?: (destination: string) => void,
): boolean {
	if (!event.altKey || event.metaKey || event.ctrlKey) return false;
	const shortcut = /^Digit([1-9])$/.exec(event.code ?? '')?.[1]
		?? (event.code === undefined || event.code === '' ? /^[1-9]$/.exec(event.key)?.[0] : undefined);
	if (shortcut === undefined) return false;
	const index = Number(shortcut) - 1;
	const project = projects[index];
	if (project === undefined) return false;
	event.preventDefault();
	const destination = `/projects/${encodeURIComponent(project.id)}`;
	if (navigate === undefined) runtime.location?.assign(destination);
	else navigate(destination);
	return true;
}

export function App(props: AppProps): React.ReactElement {
	const run = props.runs[0] ?? null;
	const currentProject = props.projects.find((project) => project.current) ?? null;
	const selection = routeSelection(
		props.surfaceRoute ?? props.route,
		currentProject?.id ?? null,
		props.selectedProjectId ?? null,
	);
	const selectedProject = props.projects.find((project) => project.id === selection.projectId) ?? null;
	const localeCatalog = LOCALE_CATALOG[props.locale];
	const [sidebarOpen, toggleSidebar] = useStoredOpen('gship-sidebar');
	const [inspectorOpen, toggleInspector] = useStoredOpen('gship-inspector');
	useEffect(() => {
		const runtime = panelRuntime();
		const onKeyDown = (event: PanelKeyEvent): void => {
			if (event.key === 'b' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				toggleSidebar();
				return;
			}
			handleProjectShortcut(event, props.projects, runtime, props.onNavigate);
		};
		runtime.addEventListener?.('keydown', onKeyDown);
		return () => runtime.removeEventListener?.('keydown', onKeyDown);
	}, [props.projects, toggleSidebar]);
	return (
		<AppShell
			controls={<ShellControls catalog={localeCatalog.shell} inspectorOpen={inspectorOpen} locale={props.locale} onSelectLocale={props.onSelectLocale} onToggleInspector={toggleInspector} onToggleSidebar={toggleSidebar} showInspectorToggle={false} sidebarOpen={sidebarOpen} />}
			sidebar={<ShellSidebar chainRuns={props.chainRuns} gitIdentity={props.gitIdentity} locale={props.locale} open={sidebarOpen} projects={props.projects} runInspectorCatalog={localeCatalog.runInspector} route={props.route} run={run} selectedProjectId={props.selectedProjectId ?? null} staleService={props.staleService} version={props.version} workspaceNotices={props.workspaceNotices} />}
			skipLabel={localeCatalog.shell.skipLinkLabel}
		>
			{props.operationalBoundary?.state === 'loading' ? <InitialOperationalLoading locale={props.locale} /> : null}
			{props.operationalBoundary?.state === 'failure' ? <InitialOperationalFailure detail={props.operationalBoundary.detail} locale={props.locale} onRetry={props.operationalBoundary.onRetry} /> : null}
			{props.operationalRefreshFailure === undefined ? null : <OperationalRefreshFailure detail={props.operationalRefreshFailure.detail} locale={props.locale} onRetry={props.operationalRefreshFailure.onRetry} />}
			{props.operationalBoundary === undefined ? <RouteScreen
				currentProjectReady={props.project.state === 'ready'}
				screens={{
					overview: () => <OverviewSurface {...props} />,
					projects: () => <ProjectsManagementSurface {...props} />,
					globalSettings: () => <GlobalSettingsSurface {...props} />,
					notFound: () => (
						<SurfaceColumn label={localeCatalog.projects.notFoundTitle} status={props.status}>
							<h2 className="font-semibold text-xl">{localeCatalog.projects.notFoundTitle}</h2>
							<p className="text-muted-foreground text-sm">{localeCatalog.projects.notFoundDescription}</p>
						</SurfaceColumn>
					),
					nonCurrent: (project, surface) => <NonCurrentProjectSurface props={props} selectedProject={project} surface={surface} />,
					onboarding: (project) => <OnboardingSurface catalog={localeCatalog.onboarding} project={props.project} settingsHref={`/projects/${encodeURIComponent(project.id)}/settings`} status={props.status} />,
					runs: () => <RunsSurface {...props} />,
					work: () => <WorkSurface {...props} />,
					settings: () => <SettingsSurface {...props} />,
				}}
				selectedProject={selectedProject}
				selection={selection}
			/> : null}
		</AppShell>
	);
}
