import type React from 'react';
import { cn } from './lib/cn.ts';

export const MAIN_CONTENT_ID = 'main-content';

/**
 * The one horizontal frame shared by the shell controls and every route
 * surface. Its measure is a shell preference, never a page-local offset.
 */
export function ShellContentFrame({
	className,
	...props
}: React.ComponentProps<'div'>): React.ReactElement {
	return <div className={cn('mx-auto w-full max-w-(--content-measure)', className)} data-slot="shell-content-frame" {...props} />;
}

/** Structural shell. Navigation and controls remain independent slots. */
export function AppShell({
	skipLabel,
	sidebar,
	controls,
	children,
}: {
	skipLabel: string;
	sidebar: React.ReactNode;
	controls: React.ReactNode;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<div className="flex h-svh w-full flex-col overflow-hidden bg-sidebar [--sidebar:var(--color-neutral-100)] lg:flex-row dark:[--sidebar:var(--color-neutral-950)]">
			<a
				className="fixed top-0 left-4 z-50 -translate-y-full rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground text-sm outline-none focus:translate-y-4 focus-visible:ring-2 focus-visible:ring-ring"
				href={`#${MAIN_CONTENT_ID}`}
			>
				{skipLabel}
			</a>
			{sidebar}
			<div className="flex min-h-0 w-full min-w-0 flex-1 flex-col p-2 lg:p-3">
				<div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--border)_64%,transparent)] bg-(--shell-panel)">
					{controls}
					{children}
				</div>
			</div>
		</div>
	);
}
