// webui/src/screens/shell.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import type { ChainPauseReason, ChainRunsView, RegisteredProjectView } from '../client.ts';
import { GateshipMark, GateshipWordmark } from '../components/gateship-logo.tsx';
import { Button } from '../components/ui/button.tsx';
import { Callout } from '../components/ui/callout.tsx';
import { cn } from '../lib/cn.ts';
import { LOCALE_CATALOG } from '../locale.ts';
import type { RunInspectorCatalog, ShellCatalog } from '../locale.ts';
import { PROJECT_SURFACES as SURFACES, routeSelection } from '../routes.ts';
import type { OperatorRoute } from '../routes.ts';
import { attentionOf } from '../run-view.ts';
import type { OperatorAttention, RunView } from '../run-view.ts';
import { Menu } from '@base-ui/react/menu';
import { Activity01Icon, ArrowExpand01Icon, ArrowLeft01Icon, ArrowRight01Icon, ArrowShrink01Icon, CubeIcon, Globe02Icon, Grid2X2Icon, ListViewIcon, Message01Icon, Moon02Icon, Settings01Icon, SidebarLeft01Icon, SidebarLeftIcon, Sun02Icon, Tick02Icon, UnfoldMoreIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useCallback, useState } from 'react';

export const NAV_LINK_CLASS =
	'flex min-h-11 items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sidebar-foreground text-sm outline-none lg:min-h-0 ' +
	'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ' +
	'focus-visible:ring-2 focus-visible:ring-sidebar-ring ' +
	'aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium ' +
	'aria-[current=page]:text-sidebar-accent-foreground';

export function StaleServiceCallout({
	staleService,
}: Pick<AppProps, 'staleService'>): React.ReactElement | null {
	if (staleService === null) return null;
	return (
		<Callout aria-label="Outdated service" title="Restart the service" tone="warning">
			<p className="break-words text-xs">{staleService.detail}</p>
			<code className="break-all text-xs">boot {staleService.bootSha}</code>
			<code className="break-all text-xs">origin/main {staleService.currentSha}</code>
		</Callout>
	);
}

/**
 * No global git author identity is configured, so the first commit a run or a
 * ship attempts would fail with "Author identity unknown" (GSHIP-654). A
 * statement, not a decision: no button, no dismissal. Unlike
 * `StaleServiceCallout`, this never asks for a restart -- derivation happens
 * on the commit path itself the moment a run or a ship actually needs it, so
 * it needs no operator action here at all; this callout is a display of that
 * outcome and clears on the next snapshot a command or a run event triggers,
 * not on a poll, since there is none.
 */
export function GitIdentityCallout({
	gitIdentity,
}: Pick<AppProps, 'gitIdentity'>): React.ReactElement | null {
	if (gitIdentity === null) return null;
	return (
		<Callout aria-label="Missing Git identity" title="Missing Git identity" tone="warning">
			<p className="break-words text-xs">{gitIdentity.detail}</p>
		</Callout>
	);
}

/** One line per reason the queue is not advancing on its own (GSHIP-638). */
export const CHAIN_PAUSE_LABELS: Readonly<Record<ChainPauseReason, string>> = {
	'chain-disabled': 'the switch is off.',
	'previous-run-not-done': 'the previous run did not finish in done.',
	'no-admissible-issue': 'there is no eligible work left in the backlog.',
	'run-active': 'a run is still active.',
	'chain-start-failed': 'the attempt to start the next run failed.',
};

/**
 * A visible queue outcome only exists while the switch is on. `setChainRuns` writes
 * the setting alone and emits no event (GSHIP-638), so a pause recorded
 * before the operator turned the switch off -- `no-admissible-issue`,
 * `previous-run-not-done`, any reason -- would otherwise survive the turn-off
 * and keep reading "Needs you" with a warning callout on every surface,
 * with nothing to clear it until some future run reaches a terminal state and
 * records a fresh `chain-disabled` pause, which may never happen (GSHIP-650
 * review). `chain-disabled` itself never escalates either, on or off: chaining
 * is off by default (GSHIP-638), so it is the steady state of a default
 * install, not a stopped queue.
 */
export function visibleQueuePause(chainRuns: ChainRunsView): ChainRunsView['pause'] {
	if (!chainRuns.enabled) return null;
	const { pause } = chainRuns;
	return pause === null || pause.reason === 'chain-disabled' ? null : pause;
}

/**
 * The queue outcome, named where the operator already looks for run status --
 * not a secondary line inside the chaining switch's own
 * settings panel, next to the toggle that turned it on. A pause whose read
 * could not resolve the issue that stopped it is still shown by its reason
 * alone: never a fabricated link. `pause` is already filtered to reasons that
 * represent a visible outcome -- see `visibleQueuePause`.
 */
export function ChainPauseCallout({
	pause,
}: { pause: ChainRunsView['pause'] }): React.ReactElement | null {
	if (pause === null) return null;
	const complete = pause.reason === 'no-admissible-issue';
	const named = pause.issue === undefined
		? CHAIN_PAUSE_LABELS[pause.reason]
		: `${pause.issue.id}: ${pause.issue.title} — ${CHAIN_PAUSE_LABELS[pause.reason]}`;
	return (
		<Callout
			aria-label={complete ? 'Completed run queue' : 'Stopped run queue'}
			title={complete ? 'Queue complete' : 'Queue stopped'}
			tone={complete ? 'success' : 'warning'}
		>
			<p className="break-words text-xs">{named}</p>
		</Callout>
	);
}

export function humanVersionOf(version: string): string {
	const buildMetadata = version.indexOf('+');
	return buildMetadata === -1 ? version : version.slice(0, buildMetadata);
}


/**
 * The nav glyphs, from Hugeicons' free set (operator decision, 2026-08-25:
 * hugeicons is the product's icon source), muted beside their labels and
 * held to one 16px slot so rows lane-align.
 */
export const NAV_GLYPHS = {
	overview: Grid2X2Icon,
	project: CubeIcon,
	conversation: Message01Icon,
	runs: Activity01Icon,
	work: ListViewIcon,
	settings: Settings01Icon,
	globalSettings: Globe02Icon,
} as const;

export function NavGlyph({ name }: { name: keyof typeof NAV_GLYPHS }): React.ReactElement {
	return (
		<HugeiconsIcon
			className="size-4 shrink-0 opacity-70"
			icon={NAV_GLYPHS[name]}
			size={16}
			strokeWidth={2.25}
		/>
	);
}

/*
 * The project switcher (operator decision, 2026-08-31, two-line
 * team-switcher anatomy): the trigger scopes projects only -- the overview
 * is a standing nav item, not a sibling scope -- and the status rides the
 * second line as text, never as a chip beside the name. The acid dot on
 * "Needs you" keeps the sidebar's one acid signal.
 */
export const SWITCHER_ITEM_CLASS =
	'flex w-full cursor-default select-none items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm outline-none ' +
	'data-highlighted:bg-accent data-highlighted:text-accent-foreground';

export function ProjectSwitcher({
	projects,
	selection,
	status,
	catalog,
}: {
	projects: AppProps['projects'];
	selection: ReturnType<typeof routeSelection>;
	status: { label: string; acid: boolean } | null;
	catalog: ShellCatalog;
}): React.ReactElement {
	const selected = projects.find((project) => project.id === selection.projectId) ?? null;
	return (
		<>
		<Menu.Root>
			<Menu.Trigger className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[popup-open]:bg-sidebar-accent">
				<span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg border">
					<NavGlyph name={selected === null ? 'overview' : 'project'} />
				</span>
				<span className="grid min-w-0 flex-1 leading-tight">
					<span className={cn('overflow-hidden text-ellipsis whitespace-nowrap font-medium text-sm', selected === null && 'text-muted-foreground')}>
						{selected?.name ?? catalog.switcherPlaceholder}
					</span>
					{selected === null || status === null ? null : (
						<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
							{status.acid ? <span className="size-1.5 shrink-0 rounded-full bg-attention" /> : null}
							<span className="overflow-hidden text-ellipsis whitespace-nowrap">{status.label}</span>
						</span>
					)}
				</span>
				<HugeiconsIcon className="size-3.5 shrink-0 opacity-70" icon={UnfoldMoreIcon} size={14} strokeWidth={2.25} />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner align="start" className="z-50" sideOffset={6}>
					<Menu.Popup className="relative min-w-(--anchor-width) origin-(--transform-origin) rounded-lg border bg-popover not-dark:bg-clip-padding p-1 text-popover-foreground shadow-lg/5 duration-100 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
						<div className="px-2 pt-1.5 pb-1 font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
							{catalog.projectNavigationLabel}
						</div>
						{projects.map((project) => (
							<Menu.Item
								className={SWITCHER_ITEM_CLASS}
								key={project.id}
								render={<a href={`/projects/${encodeURIComponent(project.id)}`} />}
							>
								<NavGlyph name="project" />
								<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
									{project.name}
								</span>
								{project.id === selection.projectId ? (
									<HugeiconsIcon className="size-3.5 shrink-0" icon={Tick02Icon} size={14} strokeWidth={2.25} />
								) : null}
							</Menu.Item>
						))}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
		{/* The registry as plain links (sr-only): a portal never reaches the
		 * static render, so without this nav the closed menu would drop
		 * every registry link from the no-JS document and from keyboard
		 * reach before hydration. */}
		<nav aria-label={catalog.projectNavigationLabel} className="sr-only">
			<ul>
				{projects.map((project) => (
					<li key={project.id}>
						<a href={`/projects/${encodeURIComponent(project.id)}`}>{project.name}</a>
					</li>
				))}
			</ul>
		</nav>
		</>
	);
}

export function ShellNavigation({
	catalog,
	projects,
	selection,
	status,
}: {
	catalog: ShellCatalog;
	projects: AppProps['projects'];
	selection: ReturnType<typeof routeSelection>;
	status: { label: string; acid: boolean } | null;
}): React.ReactElement {
	/* The overview is a standing destination, never a scope the switcher can
	 * hold: it stays one click away from every project. The project surfaces
	 * follow with no group label -- the switcher above already names the
	 * scope (operator decision, 2026-08-31). */
	return <>
		<ProjectSwitcher
			catalog={catalog}
			projects={projects}
			selection={selection}
			status={status}
		/>
		<nav aria-label={catalog.operatorNavigationLabel}>
			<ul className="flex flex-wrap gap-1 lg:flex-col lg:flex-nowrap lg:gap-0.5">
				<li className="shrink-0">
					<a
						aria-current={selection.surface === 'overview' ? 'page' : undefined}
						className={cn(
							NAV_LINK_CLASS,
							selection.surface === 'overview' && 'bg-sidebar-accent text-sidebar-accent-foreground',
						)}
						href="/overview"
					>
						<NavGlyph name="overview" /><span>{catalog.routeLabels.overview}</span>
					</a>
				</li>
				{selection.projectId === null ? null : SURFACES.map((surface) => (
					<li className="shrink-0" key={surface.surface}>
						<a
							aria-current={surface.surface === selection.surface ? 'page' : undefined}
							className={cn(
								NAV_LINK_CLASS,
								surface.surface === selection.surface && 'bg-sidebar-accent text-sidebar-accent-foreground',
							)}
							href={`/projects/${encodeURIComponent(selection.projectId ?? '')}${surface.suffix}`}
						>
							<NavGlyph name={surface.surface} /><span>{catalog.routeLabels[surface.label]}</span>
						</a>
					</li>
				))}
				<li className="shrink-0 lg:hidden">
					<a
						aria-current={selection.surface === 'global-settings' ? 'page' : undefined}
						className={cn(
							NAV_LINK_CLASS,
							selection.surface === 'global-settings' && 'bg-sidebar-accent text-sidebar-accent-foreground',
						)}
						href="/settings"
					>
						<NavGlyph name="globalSettings" /><span>{catalog.routeLabels.globalSettings}</span>
					</a>
				</li>
			</ul>
		</nav>
	</>;
}

/*
 * The root tsconfig checks this file without the DOM lib (browser types are
 * scoped to webui's own config), so the browser surface this screen touches
 * is named here, the same idiom notifications.ts uses.
 */
export interface PanelRuntime {
	localStorage?: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
	addEventListener?: (type: 'keydown', listener: (event: PanelKeyEvent) => void) => void;
	removeEventListener?: (type: 'keydown', listener: (event: PanelKeyEvent) => void) => void;
	matchMedia?: (query: string) => { matches: boolean };
	document?: { documentElement: { classList: { toggle: (name: string, force: boolean) => void } } };
}

export interface PanelKeyEvent {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	preventDefault: () => void;
}

export function panelRuntime(): PanelRuntime {
	return globalThis as unknown as PanelRuntime;
}

/**
 * Collapse state for the two side panels, persisted per browser. Reading is
 * guarded so static rendering (tests) sees the expanded default; writing
 * happens only on a real toggle, in a real browser.
 */
export function useStoredOpen(key: string): [boolean, () => void] {
	const [open, setOpen] = useState(() => panelRuntime().localStorage?.getItem(key) !== 'closed');
	const toggle = useCallback(() => {
		setOpen((previous) => {
			panelRuntime().localStorage?.setItem(key, previous ? 'closed' : 'open');
			return !previous;
		});
	}, [key]);
	return [open, toggle];
}

/**
 * The shell's persistent preferences, one row at the top right of the
 * content area (operator decision, 2026-08-25, replacing the segmented
 * pills at the sidebar's foot): language, theme and content measure, each a
 * single outline button whose face names the state it switches TO. Theme
 * and measure store an explicit choice that main.tsx re-applies at boot.
 */
export function ShellControls({
	locale,
	onSelectLocale,
	catalog,
	sidebarOpen,
	onToggleSidebar,
}: Pick<AppProps, 'locale' | 'onSelectLocale'> & {
	catalog: ShellCatalog;
	sidebarOpen: boolean;
	onToggleSidebar: () => void;
}): React.ReactElement {
	const [dark, setDark] = useState(() => {
		const runtime = panelRuntime();
		const stored = runtime.localStorage?.getItem('gship-theme') ?? null;
		if (stored !== null) return stored === 'dark';
		return runtime.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
	});
	const [wide, setWide] = useState(
		() => panelRuntime().localStorage?.getItem('gship-width') === 'wide',
	);
	const toggleTheme = (): void => {
		const next = !dark;
		const runtime = panelRuntime();
		runtime.localStorage?.setItem('gship-theme', next ? 'dark' : 'light');
		runtime.document?.documentElement.classList.toggle('dark', next);
		setDark(next);
	};
	const toggleWidth = (): void => {
		const next = !wide;
		const runtime = panelRuntime();
		runtime.localStorage?.setItem('gship-width', next ? 'wide' : 'centered');
		runtime.document?.documentElement.classList.toggle('gship-wide', next);
		setWide(next);
	};
	const targetLocale = locale === 'en-US' ? 'pt-BR' : 'en-US';
	return (
		<div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-4 lg:px-6">
			{/* The sidebar toggle lives in the content area, not the sidebar
			 * (operator decision, 2026-08-25): a panel glyph whose side bar is
			 * wide while the sidebar is open and narrow while it is collapsed. */}
			<Button
				aria-label={sidebarOpen ? catalog.sidebarToggle.collapse : catalog.sidebarToggle.expand}
				onClick={onToggleSidebar}
				size="icon"
				type="button"
				variant="outline"
			>
				<HugeiconsIcon
					className="size-3.5"
					icon={sidebarOpen ? SidebarLeftIcon : SidebarLeft01Icon}
					size={14}
					strokeWidth={3}
				/>
			</Button>
			<div aria-label={catalog.languageLabel} className="flex items-center gap-2" role="group">
			<Button
				aria-label={targetLocale === 'pt-BR' ? 'Português (Brasil)' : 'English (US)'}
				id="gateship-locale"
				onClick={() => onSelectLocale(targetLocale)}
				size="icon"
				type="button"
				variant="outline"
			>
				<span className="font-mono text-xs">{targetLocale === 'pt-BR' ? 'PT' : 'EN'}</span>
			</Button>
			<Button
				aria-label={dark ? catalog.themeToggle.light : catalog.themeToggle.dark}
				onClick={toggleTheme}
				size="icon"
				type="button"
				variant="outline"
			>
				<HugeiconsIcon
					className="size-3.5"
					icon={dark ? Sun02Icon : Moon02Icon}
					size={14}
					strokeWidth={3}
				/>
			</Button>
			<Button
				aria-label={wide ? catalog.widthToggle.compact : catalog.widthToggle.wide}
				onClick={toggleWidth}
				size="icon"
				type="button"
				variant="outline"
			>
				<HugeiconsIcon
					className="size-3.5"
					icon={wide ? ArrowShrink01Icon : ArrowExpand01Icon}
					size={14}
					strokeWidth={3}
				/>
			</Button>
			</div>
		</div>
	);
}

/* The sidebar's group label: mono, tiny, quiet (dashboard-01's anatomy). */
/* A chevron pointing where the panel will go; the label carries the meaning. */
export function PanelChevron({ direction }: { direction: 'left' | 'right' }): React.ReactElement {
	return (
		<HugeiconsIcon
			className="size-3.5"
			icon={direction === 'left' ? ArrowLeft01Icon : ArrowRight01Icon}
			size={14}
			strokeWidth={3}
		/>
	);
}

/**
 * Run state, preserved workspaces and the callouts all describe the selected
 * project, whose own scoped snapshot is what this document loaded
 * (GSHIP-707). A queue pause is the one exception: run chaining is the boot
 * runtime's switch, so it is only ever stated for the current project.
 */
export function shellAttention(
	selected: RegisteredProjectView | null,
	chainRuns: ChainRunsView,
	run: RunView | null,
	workspaceNotices: AppProps['workspaceNotices'],
): { operational: boolean; queuePause: ChainRunsView['pause']; attention: OperatorAttention } {
	const operational = selected !== null && (selected.current || selected.readiness === 'ready');
	const queuePause = selected?.current === true ? visibleQueuePause(chainRuns) : null;
	const stoppedQueue = queuePause !== null && queuePause.reason !== 'no-admissible-issue';
	return {
		operational,
		queuePause,
		attention: attentionOf(operational ? run : null, operational ? workspaceNotices : [], stoppedQueue),
	};
}

/**
 * The collapsed shell: the mark, the attention signal if any, and the way
 * back. Everything else waits behind the toggle (or Cmd/Ctrl+B).
 */
export function ShellRail({ needsYou }: { needsYou: boolean }): React.ReactElement {
	/* pt-6 at lg matches the expanded sidebar's own p-6 (operator decision,
	 * 2026-08-25): the mark shares the same vertical anchor collapsed and
	 * expanded, so toggling reads as a width change, not the logo jumping. */
	return (
		<header className="flex shrink-0 items-center gap-3 p-4 lg:h-full lg:w-18 lg:flex-col lg:items-center lg:pt-8">
			<GateshipMark className="size-6 translate-x-px" portal />
			{needsYou ? <span aria-hidden="true" className="size-2 rounded-full bg-attention" /> : null}
		</header>
	);
}

export function ShellSidebar({
	chainRuns,
	gitIdentity,
	locale,
	runInspectorCatalog,
	route,
	projects,
	run,
	staleService,
	version,
	workspaceNotices,
	open,
}: Pick<AppProps, 'chainRuns' | 'gitIdentity' | 'locale' | 'projects' | 'staleService' | 'workspaceNotices'> & {
	runInspectorCatalog: RunInspectorCatalog;
	route: OperatorRoute;
	run: RunView | null;
	version: string;
	open: boolean;
}): React.ReactElement {
	// The header answers one question -- is Gateship waiting on the operator --
	// so it carries the human state alone. The run's own state stays on the
	// card. A stopped chain queue (GSHIP-650) answers it too, the same way a
	// preserved workspace already does -- but only while the switch is on and
	// something else stopped it, never for the switch simply being off.
	const catalog = LOCALE_CATALOG[locale].shell;
	const currentId = projects.find((project) => project.current)?.id ?? null;
	const selection = routeSelection(route, currentId);
	const selected = projects.find((project) => project.id === selection.projectId) ?? null;
	const { operational, queuePause, attention } = shellAttention(
		selected,
		chainRuns,
		run,
		workspaceNotices,
	);
	const humanVersion = humanVersionOf(version);
	if (!open) {
		return <ShellRail needsYou={operational && attention === 'Needs you'} />;
	}
	/* The shell chrome deepens its own --sidebar one step (operator decision,
	 * 2026-08-25): the body canvas keeps the global token, so the sidebar
	 * separates from the content by fill, not only by its hairline border.
	 * @theme inline makes bg-sidebar read the var in cascade, so the
	 * element-level override is all it takes. */
	return (
		<header className="flex shrink-0 flex-col gap-2 px-3 pt-3 lg:h-full lg:w-64 lg:gap-4 lg:overflow-y-auto lg:p-6 lg:pt-8">
			<h1 className="flex items-center gap-2">
				<span aria-hidden="true">
					<GateshipMark className="size-6 translate-x-px" portal />
				</span>
				<GateshipWordmark className="block aspect-[10187/2750] h-5 w-auto" />
			</h1>
			<ShellNavigation
				catalog={catalog}
				projects={projects}
				selection={selection}
				/* "Needs you" is the navigation's one acid point (design-system.md 1). */
				status={operational ? { label: runInspectorCatalog.attentionLabels[attention], acid: attention === 'Needs you' } : null}
			/>
			<div className="hidden lg:contents">
				<ChainPauseCallout pause={queuePause} />
				{operational ? <StaleServiceCallout staleService={staleService} /> : null}
				{operational ? <GitIdentityCallout gitIdentity={gitIdentity} /> : null}
			</div>
			<nav aria-label={catalog.routeLabels.globalSettings} className="hidden lg:mt-auto lg:block">
				<a
					aria-current={selection.surface === 'global-settings' ? 'page' : undefined}
					className={cn(NAV_LINK_CLASS, selection.surface === 'global-settings' && 'bg-sidebar-accent text-sidebar-accent-foreground')}
					href="/settings"
				>
					<NavGlyph name="globalSettings" /><span className="min-w-0 overflow-hidden text-ellipsis">{catalog.routeLabels.globalSettings}</span>
				</a>
			</nav>
			{version === '' ? null : (
				<span className="hidden px-3 font-mono text-[10px] text-sidebar-foreground/50 uppercase tracking-wider lg:inline">v{humanVersion}</span>
			)}
		</header>
	);
}

/**
 * The one onboarding write the overview offers: an absolute path to a checkout
 * the operator already has. No file picker, no clone and no new repository --
 * the service reads local Git metadata and refuses anything not ready.
 */
