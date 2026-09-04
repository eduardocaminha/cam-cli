import type React from 'react';
import type { RegisteredProjectView } from '../client.ts';
import type { ProjectSurface, RouteSelection } from '../routes.ts';

interface RouteScreens {
	overview: () => React.ReactElement;
	projects: () => React.ReactElement;
	globalSettings: () => React.ReactElement;
	notFound: () => React.ReactElement;
	nonCurrent: (project: RegisteredProjectView, surface: ProjectSurface) => React.ReactElement;
	onboarding: (project: RegisteredProjectView) => React.ReactElement;
	conversation: () => React.ReactElement;
	runs: () => React.ReactElement;
	work: () => React.ReactElement;
	settings: () => React.ReactElement;
}

/** Route-owned screen selection, independent from the shell and transport. */
export function RouteScreen({
	selection,
	selectedProject,
	currentProjectReady,
	screens,
}: {
	selection: RouteSelection;
	selectedProject: RegisteredProjectView | null;
	currentProjectReady: boolean;
	screens: RouteScreens;
}): React.ReactElement {
	if (selection.surface === 'overview') return screens.overview();
	if (selection.surface === 'projects') return screens.projects();
	if (selection.surface === 'global-settings') return screens.globalSettings();
	if (selectedProject === null) return screens.notFound();
	if (!selectedProject.current) return screens.nonCurrent(selectedProject, selection.surface);
	if (!currentProjectReady && selection.surface !== 'settings') return screens.onboarding(selectedProject);
	if (selection.surface === 'runs') return screens.runs();
	if (selection.surface === 'work') return screens.work();
	if (selection.surface === 'settings') return screens.settings();
	return screens.conversation();
}
