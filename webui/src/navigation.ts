/** The browser details that decide whether an anchor remains a normal link. */
export interface NavigationIntent {
	currentUrl: string;
	href: string;
	defaultPrevented: boolean;
	button: number;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	target: string;
	download: boolean;
}

function isOperatorPath(pathname: string): boolean {
	const normalized = pathname.replace(/\/+$/, '') || '/';
	return normalized === '/overview'
		|| normalized === '/'
		|| normalized === '/runs'
		|| normalized === '/work'
		|| normalized === '/settings'
		|| /^\/projects\/[^/]+(?:\/(?:runs|work|settings))?$/.test(normalized);
}

/**
 * Returns an internal operator destination to place in browser history. `null`
 * leaves the anchor entirely to the browser, including every special link.
 */
export function clientNavigationTarget(intent: NavigationIntent): string | null {
	if (intent.defaultPrevented || intent.button !== 0 || intent.altKey || intent.ctrlKey || intent.metaKey || intent.shiftKey) return null;
	if (intent.target !== '' || intent.download) return null;
	let current: URL;
	let destination: URL;
	try {
		current = new URL(intent.currentUrl);
		destination = new URL(intent.href, current);
	} catch {
		return null;
	}
	if (destination.origin !== current.origin || destination.hash !== '' || destination.search !== '') return null;
	if (!isOperatorPath(destination.pathname)) return null;
	return destination.pathname;
}
