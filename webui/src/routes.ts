import type { ShellCatalog } from './locale.ts';

/** Project selection and surface both come from this URL, never hidden state. */
export type OperatorRoute = '/overview' | `/projects/${string}` | '/' | '/runs' | '/work' | '/settings';

export type ProjectSurface = 'conversation' | 'runs' | 'work' | 'settings';

export interface RouteSelection {
	projectId: string | null;
	surface: ProjectSurface | 'overview' | 'global-settings';
}

export const PROJECT_SURFACES: readonly {
	suffix: string;
	label: keyof ShellCatalog['routeLabels'];
	surface: ProjectSurface;
}[] = [
	{ suffix: '', label: 'conversation', surface: 'conversation' },
	{ suffix: '/runs', label: 'runs', surface: 'runs' },
	{ suffix: '/work', label: 'work', surface: 'work' },
	{ suffix: '/settings', label: 'settings', surface: 'settings' },
];

export function routeOf(pathname: string): OperatorRoute {
	const normalized = pathname.replace(/\/+$/, '');
	const path = normalized === '' ? '/' : normalized;
	if (path === '/overview') return path;
	if (path === '/' || path === '/runs' || path === '/work' || path === '/settings') return path;
	if (/^\/projects\/[^/]+(?:\/(?:runs|work|settings))?$/.test(path)) {
		return path as `/projects/${string}`;
	}
	return '/overview';
}

export function routeSelection(route: OperatorRoute, currentId: string | null): RouteSelection {
	if (route === '/overview') return { projectId: null, surface: 'overview' };
	const legacy = route === '/' ? 'conversation' : route.slice(1);
	if (route === '/settings') return { projectId: null, surface: 'global-settings' };
	if (route === '/' || route === '/runs' || route === '/work') {
		return { projectId: currentId, surface: legacy as ProjectSurface };
	}
	const match = /^\/projects\/([^/]+)(?:\/(runs|work|settings))?$/.exec(route);
	if (match === null) return { projectId: null, surface: 'overview' };
	let projectId = match[1] ?? '';
	try { projectId = decodeURIComponent(projectId); } catch { /* unmatched id stays unavailable */ }
	return { projectId, surface: (match[2] ?? 'conversation') as ProjectSurface };
}

export function projectIdOf(pathname: string): string | null {
	return routeSelection(routeOf(pathname), null).projectId;
}
