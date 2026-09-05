// webui/src/screens/shell.tsx

import React from 'react';
import type { AppProps } from '../app-props.ts';
import { ShellContentFrame } from '../app-shell.tsx';
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
import { Activity01Icon, ArrowExpand01Icon, ArrowShrink01Icon, CubeIcon, FolderManagementIcon, Globe02Icon, Grid2X2Icon, ListViewIcon, Message01Icon, Moon02Icon, Settings01Icon, Sun02Icon, UnfoldMoreIcon } from '@hugeicons/core-free-icons';
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
	'data-highlighted:bg-accent data-highlighted:text-accent-foreground ' +
	'aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground';

function ProjectShortcut({ index }: { index: number | undefined }): React.ReactElement {
	return (
		<span className="flex w-10 shrink-0 justify-center">
			{index === undefined ? null : <kbd aria-hidden="true" className="rounded border border-border bg-muted px-1 font-mono text-[10px] leading-4 text-muted-foreground">Alt+{index + 1}</kbd>}
		</span>
	);
}

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
	const selectedIndex = selected === null ? undefined : projects.indexOf(selected);
	const selectedShortcut = selectedIndex === undefined || selectedIndex > 8 ? undefined : selectedIndex;
	return (
		<>
			<Menu.Root>
				<Menu.Trigger
					className={cn(NAV_LINK_CLASS, 'w-full text-left data-[popup-open]:bg-sidebar-accent')}
					data-slot="project-switcher"
				>
					{selected === null
						? <span aria-hidden="true" className="size-4 shrink-0" />
						: <ProjectShortcut index={selectedShortcut} />}
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
						{projects.map((project, index) => (
							<Menu.Item
								aria-current={project.id === selection.projectId ? 'page' : undefined}
								className={SWITCHER_ITEM_CLASS}
								key={project.id}
								render={<a href={`/projects/${encodeURIComponent(project.id)}`} />}
							>
								<ProjectShortcut index={index < 9 ? index : undefined} />
								<span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
									{project.name}
								</span>
							</Menu.Item>
						))}
						<Menu.Item
							className={cn(SWITCHER_ITEM_CLASS, 'mt-1')}
							render={<a href="/projects" />}
						>
							<HugeiconsIcon className="size-4 shrink-0 opacity-70" icon={FolderManagementIcon} size={16} strokeWidth={2.25} />
							<span className="min-w-0 flex-1">{catalog.manageProjectsLabel}</span>
						</Menu.Item>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
		{/* The registry as plain links (sr-only): a portal never reaches the
		 * static render, so without this nav the closed menu would drop
		 * every registry link from the no-JS document and from keyboard
		 * reach before hydration. */}
		<div aria-label={catalog.projectNavigationLabel} className="sr-only">
			<ul>
				{projects.map((project, index) => (
					<li key={project.id}>
						<a aria-current={project.id === selection.projectId ? 'page' : undefined} href={`/projects/${encodeURIComponent(project.id)}`}><ProjectShortcut index={index < 9 ? index : undefined} />{project.name}</a>
					</li>
				))}
				<li><a href="/projects">{catalog.manageProjectsLabel}</a></li>
			</ul>
		</div>
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
	/* Overview is global. The project switcher begins its own contextual group;
	 * project surfaces are a semantic child list, visually nested on desktop. */
	return (
		<nav aria-label={catalog.operatorNavigationLabel}>
			<ul className="flex flex-wrap gap-1 lg:flex-col lg:flex-nowrap lg:gap-0.5" data-slot="global-navigation">
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
			</ul>
			<div className="mt-3 lg:mt-5" data-slot="project-navigation">
				<ul className="flex flex-wrap gap-1 lg:flex-col lg:flex-nowrap lg:gap-0.5">
				<li className="w-full min-w-0" data-slot="project-switcher-item">
					<ProjectSwitcher
						catalog={catalog}
						projects={projects}
						selection={selection}
						status={status}
					/>
					{selection.projectId === null ? null : (
						<ul className="flex flex-wrap gap-1 lg:mt-1 lg:flex-col lg:flex-nowrap lg:gap-0.5 lg:pl-2" data-slot="project-surface-navigation">
							{SURFACES.map((surface) => (
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
						</ul>
					)}
				</li>
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
			</div>
		</nav>
	);
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
	location?: { assign: (url: string) => void };
	matchMedia?: (query: string) => { matches: boolean };
	document?: { documentElement: { classList: { toggle: (name: string, force: boolean) => void } } };
}

export interface PanelKeyEvent {
	key: string;
	code?: string;
	altKey: boolean;
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
	inspectorOpen,
	onToggleInspector,
	showInspectorToggle,
}: Pick<AppProps, 'locale' | 'onSelectLocale'> & {
	catalog: ShellCatalog;
	sidebarOpen: boolean;
	onToggleSidebar: () => void;
	inspectorOpen: boolean;
	onToggleInspector: () => void;
	showInspectorToggle: boolean;
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
	const inspectorColumnOpen = showInspectorToggle && inspectorOpen;
	const inspectorToggle = (className?: string): React.ReactElement | null => showInspectorToggle ? (
		<Button
			aria-label={inspectorOpen ? catalog.inspectorToggle.collapse : catalog.inspectorToggle.expand}
			className={className}
			onClick={onToggleInspector}
			size="icon"
			type="button"
			variant="outline"
		>
			<PanelToggleGlyph side="right" />
		</Button>
	) : null;
	return (
		<div className={cn('w-full shrink-0', inspectorColumnOpen && 'xl:grid xl:grid-cols-[minmax(0,1fr)_24rem]')} data-slot="shell-controls-layout">
			<div className="min-w-0 px-4 pt-4 lg:px-6">
				<ShellContentFrame className="flex items-center justify-between gap-2">
					{/* The sidebar toggle lives in the content area, not the sidebar. */}
					<Button
						aria-label={sidebarOpen ? catalog.sidebarToggle.collapse : catalog.sidebarToggle.expand}
						onClick={onToggleSidebar}
						size="icon"
						type="button"
						variant="outline"
					>
						<PanelToggleGlyph side="left" />
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
							className="hidden 2xl:inline-flex"
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
						{inspectorToggle(inspectorColumnOpen ? 'xl:hidden' : undefined)}
					</div>
				</ShellContentFrame>
			</div>
			{inspectorColumnOpen ? <div className="hidden items-center justify-end px-4 pt-4 lg:px-6 xl:flex">{inspectorToggle('hidden xl:inline-flex')}</div> : null}
		</div>
	);
}

/** A panel silhouette with its visible side fully filled in currentColor. */
export function PanelToggleGlyph({ side }: { side: 'left' | 'right' }): React.ReactElement {
	return (
		<svg aria-hidden="true" className="size-3.5" data-side={side} data-slot="panel-toggle-glyph" fill="none" viewBox="0 0 16 16">
			<rect height="12" rx="1.5" stroke="currentColor" strokeWidth="2.5" width="12" x="2" y="2" />
			<rect fill="currentColor" height="12" rx="1" width="3.5" x={side === 'left' ? '2' : '10.5'} y="2" />
		</svg>
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
	 * expanded, so toggling reads as a width change, not the logo jumping.
	 * The rail remains 72px, but half of the content panel's 12px outer spacing
	 * belongs to its visual corridor. That makes the corridor 78px wide, whose
	 * centre advances 3px; the mark keeps its 1px optical adjustment, for 4px.
	 * The expanded sidebar uses the same correction so the mark stays fixed. */
	return (
		<header className="flex shrink-0 items-center gap-3 p-4 lg:h-full lg:w-18 lg:flex-col lg:items-center lg:pt-8">
			<GateshipMark className="size-6 translate-x-px lg:translate-x-[4px]" portal />
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
			<h1 className="flex items-center gap-2 lg:gap-3">
				<span aria-hidden="true">
					<GateshipMark className="size-6 translate-x-px lg:translate-x-[4px]" portal />
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
 * The one onboarding write project management offers: an absolute path to a checkout
 * the operator already has. No file picker, no clone and no new repository --
 * the service reads local Git metadata and refuses anything not ready.
 */
