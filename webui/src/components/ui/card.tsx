// webui/src/components/ui/card.tsx
//
// The panel surface of the operator shell, on coss ui's CardFrame anatomy
// (packages/ui/src/components/card.tsx, vendored verbatim by operator
// decision 2026-08-25): the outer element is coss's CardFrame -- border,
// hairline bevel, a muted wash that shows through wherever no inner card
// covers it -- the header sits directly on that frame, and CardPanel is
// coss's nested inner Card (own border, smaller top radius, -1px margin so
// its edges fuse with the frame's border; the frame's child selectors do
// the rounding, clipping and shadow suppression). Gateship keeps its own
// exported names so no call site changes: Card here is coss's CardFrame,
// CardPanel is coss's nested Card + CardPanel pair.
//
// Gateship's own layers on top of the vendored strings: the card-ring
// outer ring (index.css), the acid focus ring through --ring, and the
// details/summary disclosure pair (a disclosure has to be a real <details>;
// collapsed is a rendering state, never an unmounted branch, ADR-0067).

import type React from 'react';
import { cn } from '../../lib/cn.ts';

/*
 * coss CardFrame, verbatim, in three pieces: the surface, the child-card
 * plumbing (margins, rounding, clip and shadow suppression for a nested
 * [data-slot=card]), and the muted wash. The wash is guarded behind
 * has-data-[slot=card] -- coss chooses Card vs CardFrame per call site,
 * this screen has one component for both, and a frame with no inner card
 * (a plain padded card) must not render all-gray.
 */
const FRAME =
	'card-ring relative flex flex-col rounded-2xl border bg-card not-dark:bg-clip-padding text-card-foreground ' +
	'[--clip-bottom:-1rem] [--clip-top:-1rem] ' +
	'before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] ' +
	'has-data-[slot=card]:before:bg-muted/72 ' +
	'before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)] ' +
	'has-data-[slot=table-container]:overflow-hidden ' +
	'*:data-[slot=card]:-m-px *:data-[slot=table-container]:-m-px *:data-[slot=table-container]:w-[calc(100%+2px)] ' +
	'*:not-first:data-[slot=card]:rounded-t-xl *:not-last:data-[slot=card]:rounded-b-xl ' +
	'*:data-[slot=card]:bg-clip-padding *:data-[slot=card]:shadow-none *:data-[slot=card]:before:hidden ' +
	'*:not-first:data-[slot=card]:before:rounded-t-[calc(var(--radius-xl)-1px)] ' +
	'*:not-last:data-[slot=card]:before:rounded-b-[calc(var(--radius-xl)-1px)] ' +
	'*:data-[slot=card]:[clip-path:inset(var(--clip-top)_1px_var(--clip-bottom)_1px_round_calc(var(--radius-2xl)-1px))] ' +
	'*:data-[slot=card]:last:[--clip-bottom:1px] *:data-[slot=card]:first:[--clip-top:1px]';

/* coss CardFrameHeader, verbatim. */
const HEADER =
	'relative grid auto-rows-min grid-rows-[auto_auto] items-start gap-x-4 px-6 py-4 ' +
	'has-data-[slot=card-frame-action]:grid-cols-[1fr_auto]';

/*
 * coss's inner Card, verbatim, plus the homepage's own fill for it
 * (apps/ui/app/page.tsx): --color-card mixed with --color-sidebar, barely
 * lighter than the canvas. The frame's child selectors above override the
 * shadow, bevel and rounding, so this class list mostly matters when the
 * markup is inspected in isolation.
 */
const INNER_CARD =
	'relative flex flex-1 flex-col rounded-2xl border bg-card not-dark:bg-clip-padding text-card-foreground ' +
	'before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] ' +
	'before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)] ' +
	'bg-[color-mix(in_srgb,var(--color-card),var(--color-sidebar))]';

export function Card({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
	return <div className={cn(FRAME, className)} data-slot="card-frame" {...props} />;
}

/** The same surface, disclosed natively. `open` is the initial state only. */
export function CardDisclosure({
	className,
	...props
}: React.ComponentProps<'details'>): React.ReactElement {
	return <details className={cn(FRAME, className)} data-slot="card-frame" {...props} />;
}

export function CardHeader({
	className,
	...props
}: React.ComponentProps<'div'>): React.ReactElement {
	return <div className={cn(HEADER, className)} data-slot="card-frame-header" {...props} />;
}

/**
 * The header of a <CardDisclosure>, which is also its whole click target. The
 * default triangle marker is removed in both spellings browsers use for it.
 */
export function CardSummary({
	className,
	...props
}: React.ComponentProps<'summary'>): React.ReactElement {
	return (
		<summary
			className={cn(
				HEADER,
				'cursor-pointer list-none [&::-webkit-details-marker]:hidden',
				className,
			)}
			data-slot="card-frame-header"
			{...props}
		/>
	);
}

/*
 * coss CardFrameTitle composed with its homepage override (font-heading,
 * bold, text-base): the registry base alone is a text-sm docs label, the
 * homepage form is the card title this screen means.
 */
export function CardTitle({ className, ...props }: React.ComponentProps<'h2'>): React.ReactElement {
	return (
		<h2
			className={cn('self-center font-bold font-heading text-base', className)}
			data-slot="card-frame-title"
			{...props}
		/>
	);
}

/* coss CardFrameDescription, verbatim. */
export function CardDescription({
	className,
	...props
}: React.ComponentProps<'div'>): React.ReactElement {
	return (
		<div
			className={cn('self-center text-muted-foreground text-sm', className)}
			data-slot="card-frame-description"
			{...props}
		/>
	);
}

/** Sits in the header's second column, spanning title and description. */
export function CardAction({
	className,
	...props
}: React.ComponentProps<'span'>): React.ReactElement {
	return (
		<span
			className={cn(
				'col-start-2 row-span-2 row-start-1 inline-flex self-center justify-self-end',
				className,
			)}
			data-slot="card-frame-action"
			{...props}
		/>
	);
}

/**
 * coss's frame content slot: a nested inner card (the frame's selectors pull
 * it flush and re-round it) holding coss's own CardPanel. `className` lands
 * on the panel, where call sites have always put their layout.
 */
export function CardPanel({
	className,
	children,
	...props
}: React.ComponentProps<'div'>): React.ReactElement {
	return (
		<div className={INNER_CARD} data-slot="card">
			<div className={cn('flex-1 p-6', className)} data-slot="card-panel" {...props}>
				{children}
			</div>
		</div>
	);
}
