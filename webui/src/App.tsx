// webui/src/App.tsx
//
// The application entry point stays deliberately narrow. Route surfaces are
// implemented under screens so this module remains the stable public boundary.

import React, { useEffect } from 'react';
import type { AppProps } from './app-props.ts';
import { AppShell } from './app-shell.tsx';
import { LOCALE_CATALOG } from './locale.ts';
import { routeSelection } from './routes.ts';
import { RouteScreen } from './screens/route-screen.tsx';
import { SurfaceColumn } from './screens/surface-column.tsx';
import { GlobalSettingsSurface } from './screens/global-settings-screen.tsx';
import { HomeSurface } from './screens/home-screen.tsx';
import { NonCurrentProjectSurface } from './screens/non-current-project-screen.tsx';
import { OnboardingSurface } from './screens/onboarding-screen.tsx';
import { OverviewSurface } from './screens/overview-screen.tsx';
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
export { ConversationColumn } from './screens/conversation.tsx';
export type { AppProps } from './app-props.ts';
export type { OperatorRoute } from './routes.ts';

export function App(props: AppProps): React.ReactElement {
	const run = props.runs[0] ?? null;
	const currentProject = props.projects.find((project) => project.current) ?? null;
	const selection = routeSelection(props.route, currentProject?.id ?? null);
	const selectedProject = props.projects.find((project) => project.id === selection.projectId) ?? null;
	const localeCatalog = LOCALE_CATALOG[props.locale];
	const [sidebarOpen, toggleSidebar] = useStoredOpen('gship-sidebar');
	useEffect(() => {
		const runtime = panelRuntime();
		const onKeyDown = (event: PanelKeyEvent): void => {
			if (event.key === 'b' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				toggleSidebar();
			}
		};
		runtime.addEventListener?.('keydown', onKeyDown);
		return () => runtime.removeEventListener?.('keydown', onKeyDown);
	}, [toggleSidebar]);
	return (
		<AppShell
			controls={<ShellControls catalog={localeCatalog.shell} locale={props.locale} onSelectLocale={props.onSelectLocale} onToggleSidebar={toggleSidebar} sidebarOpen={sidebarOpen} />}
			sidebar={<ShellSidebar chainRuns={props.chainRuns} gitIdentity={props.gitIdentity} locale={props.locale} open={sidebarOpen} projects={props.projects} runInspectorCatalog={localeCatalog.runInspector} route={props.route} run={run} staleService={props.staleService} version={props.version} workspaceNotices={props.workspaceNotices} />}
			skipLabel={localeCatalog.shell.skipLinkLabel}
		>
			<RouteScreen
				currentProjectReady={props.project.state === 'ready'}
				screens={{
					overview: () => <OverviewSurface {...props} />,
					globalSettings: () => <GlobalSettingsSurface {...props} />,
					notFound: () => (
						<SurfaceColumn label={localeCatalog.projects.notFoundTitle} status={props.status}>
							<h2 className="font-semibold text-xl">{localeCatalog.projects.notFoundTitle}</h2>
							<p className="text-muted-foreground text-sm">{localeCatalog.projects.notFoundDescription}</p>
						</SurfaceColumn>
					),
					nonCurrent: (project, surface) => <NonCurrentProjectSurface props={props} selectedProject={project} surface={surface} />,
					onboarding: (project) => <OnboardingSurface catalog={localeCatalog.onboarding} project={props.project} settingsHref={`/projects/${encodeURIComponent(project.id)}/settings`} status={props.status} />,
					conversation: () => <HomeSurface {...props} projectId={selectedProject?.id ?? ''} />,
					runs: () => <RunsSurface {...props} />,
					work: () => <WorkSurface {...props} />,
					settings: () => <SettingsSurface {...props} />,
				}}
				selectedProject={selectedProject}
				selection={selection}
			/>
		</AppShell>
	);
}
