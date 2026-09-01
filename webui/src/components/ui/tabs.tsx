// webui/src/components/ui/tabs.tsx
//
// Gateship's tabs use the Base UI primitive. The list is
// a muted well, and the active tab is marked by a sliding indicator -- a
// background-colored pill that animates between tabs via Base UI's
// --active-tab-* variables -- instead of per-tab selected styles.
//
// TabsCount is the count chip a tab carries; it is acid when
// the queue waits on the operator), panels that stay mounted (find-in-page
// and static rendering keep seeing the whole surface), and the panel's
// stack layout, which every surface on this screen relies on.

import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import type React from 'react';
import {
	segmentedControlItemLayoutClassName,
	segmentedControlItemSizeClassNames,
} from '../../lib/segmented-control.ts';
import { cn } from '../../lib/cn.ts';

export function Tabs({
	className,
	...props
}: Omit<TabsPrimitive.Root.Props, 'className'> & { className?: string }): React.ReactElement {
	return (
		<TabsPrimitive.Root
			className={cn('flex flex-col gap-2', className)}
			data-slot="tabs"
			{...props}
		/>
	);
}

export function TabsList({
	className,
	children,
	...props
}: Omit<TabsPrimitive.List.Props, 'className'> & { className?: string }): React.ReactElement {
	return (
		<div
			className="relative max-w-full after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-8 after:rounded-r-lg after:bg-linear-to-r after:from-transparent after:to-muted sm:after:hidden"
			data-slot="tabs-scroll-frame"
		>
			<div className="max-w-full overflow-x-auto rounded-lg" data-slot="tabs-scroll">
				<TabsPrimitive.List
					className={cn(
						'relative z-0 flex w-max min-w-full items-center justify-start gap-x-0.5 rounded-lg bg-muted py-0.5 pr-8 pl-0.5 text-muted-foreground/72 sm:pr-0.5',
						className,
					)}
					data-slot="tabs-list"
					{...props}
				>
					{children}
					<TabsPrimitive.Indicator
						className={
							'absolute bottom-0 left-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) -translate-y-(--active-tab-bottom) ' +
							'-z-1 rounded-md bg-background shadow-sm/5 transition-[width,translate] duration-200 ease-in-out motion-reduce:transition-none dark:bg-input'
						}
						data-slot="tab-indicator"
					/>
				</TabsPrimitive.List>
			</div>
		</div>
	);
}

export function TabsTab({
	className,
	...props
}: Omit<TabsPrimitive.Tab.Props, 'className'> & { className?: string }): React.ReactElement {
	return (
		<TabsPrimitive.Tab
			className={cn(
				'relative flex shrink-0 grow cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-transparent font-medium text-base outline-none pointer-coarse:min-h-11 ' +
					'transition-[color,background-color,box-shadow] hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ' +
					'data-active:text-foreground data-disabled:pointer-events-none data-disabled:opacity-64 sm:text-sm',
				segmentedControlItemLayoutClassName,
				segmentedControlItemSizeClassNames.default,
				className,
			)}
			data-slot="tabs-tab"
			{...props}
		/>
	);
}

/** The count chip a tab carries; `attention` marks a queue waiting on the operator. */
export function TabsCount({
	attention = false,
	children,
}: {
	attention?: boolean;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<span
			className={cn(
				'inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 font-mono text-[10px] tabular-nums',
				attention ? 'bg-attention text-attention-foreground' : 'bg-muted text-muted-foreground',
			)}
		>
			{children}
		</span>
	);
}

export function TabsPanel({
	className,
	...props
}: Omit<TabsPrimitive.Panel.Props, 'className'> & { className?: string }): React.ReactElement {
	return (
		<TabsPrimitive.Panel
			className={cn('flex flex-1 flex-col gap-6 outline-none', className)}
			data-slot="tabs-content"
			keepMounted
			{...props}
		/>
	);
}
