// webui/src/components/ui/card.tsx
//
// The panel surface of the operator shell: a bordered card with a header, an
// optional affordance in the header's second column, and a body.
//
// Most of the shell's panels are native disclosures, so the same surface is
// also offered as a <details>/<summary> pair. That is a named pair of
// components rather than a polymorphic render prop, because those two tags are
// the only substitution this screen has ever needed, and because a disclosure
// has to be a real <details> -- collapsed is a rendering state, never an
// unmounted branch (ADR-0067).
//
// The data-slot attributes are load-bearing and not decoration: the header
// drops its bottom padding only when the card also carries a body, the body
// drops its top padding only when the card also carries a header, and the
// header becomes two columns only when it carries an action.

import type React from 'react';
import { cn } from '../../lib/cn.ts';

const SURFACE =
	'relative flex flex-col rounded-2xl border bg-card not-dark:bg-clip-padding ' +
	'text-card-foreground shadow-xs/5 before:pointer-events-none before:absolute before:inset-0 ' +
	'before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] ' +
	'dark:before:shadow-[0_-1px_--theme(--color-white/6%)]';

const HEADER =
	'grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 p-6 ' +
	'in-[[data-slot=card]:has(>[data-slot=card-panel])]:pb-4 ' +
	'has-data-[slot=card-action]:grid-cols-[1fr_auto]';

export function Card({ className, ...props }: React.ComponentProps<'div'>): React.ReactElement {
	return <div className={cn(SURFACE, className)} data-slot="card" {...props} />;
}

/** The same surface, disclosed natively. `open` is the initial state only. */
export function CardDisclosure({
	className,
	...props
}: React.ComponentProps<'details'>): React.ReactElement {
	return <details className={cn(SURFACE, className)} data-slot="card" {...props} />;
}

export function CardHeader({
	className,
	...props
}: React.ComponentProps<'div'>): React.ReactElement {
	return <div className={cn(HEADER, className)} data-slot="card-header" {...props} />;
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
			data-slot="card-header"
			{...props}
		/>
	);
}

export function CardTitle({ className, ...props }: React.ComponentProps<'h2'>): React.ReactElement {
	return (
		<h2
			className={cn('font-heading font-semibold text-lg leading-none', className)}
			data-slot="card-title"
			{...props}
		/>
	);
}

export function CardDescription({
	className,
	...props
}: React.ComponentProps<'div'>): React.ReactElement {
	return (
		<div
			className={cn('text-muted-foreground text-sm', className)}
			data-slot="card-description"
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
				'col-start-2 row-span-2 row-start-1 inline-flex self-start justify-self-end',
				className,
			)}
			data-slot="card-action"
			{...props}
		/>
	);
}

export function CardPanel({
	className,
	...props
}: React.ComponentProps<'div'>): React.ReactElement {
	return (
		<div
			className={cn(
				'flex-1 p-6 in-[[data-slot=card]:has(>[data-slot=card-header])]:pt-0',
				className,
			)}
			data-slot="card-panel"
			{...props}
		/>
	);
}
