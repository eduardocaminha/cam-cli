import type { RegisteredProjectView } from './client.ts';

/** Browser-only preference for contextual navigation, never an API scope. */
export const PROJECT_SELECTION_STORAGE_KEY = 'gship-selected-project';

export interface ProjectSelectionStorage {
	getItem: (key: string) => string | null;
	setItem: (key: string, value: string) => void;
	removeItem: (key: string) => void;
}

export function readProjectSelection(read: () => string | null): string | null {
	try {
		const projectId = read();
		return projectId === null || projectId === '' ? null : projectId;
	} catch {
		return null;
	}
}

/**
 * A project route refreshes contextual navigation when its id is registered.
 * Every other route preserves the last valid selection. No route invents one.
 */
export function reconciledProjectSelection(
	routeProjectId: string | null,
	selectedProjectId: string | null,
	projects: readonly RegisteredProjectView[],
): string | null {
	if (routeProjectId !== null && projects.some((project) => project.id === routeProjectId)) {
		return routeProjectId;
	}
	return selectedProjectId !== null && projects.some((project) => project.id === selectedProjectId)
		? selectedProjectId
		: null;
}

export function writeProjectSelection(
	storage: ProjectSelectionStorage | undefined,
	projectId: string | null,
): void {
	try {
		if (projectId === null) storage?.removeItem(PROJECT_SELECTION_STORAGE_KEY);
		else storage?.setItem(PROJECT_SELECTION_STORAGE_KEY, projectId);
	} catch {
		// Navigation remains usable when browser persistence is unavailable.
	}
}
