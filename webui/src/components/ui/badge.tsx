// webui/src/components/ui/badge.tsx
//
// Gateship's compact status chip. Its semantic variants
// are an 8% wash of their own hue (16% on dark), never a solid. Badges on
// this screen only ever report what the runtime decided, so the component
// takes a variant and children and nothing else: no sizes, no link or
// button form, no click target.
//
// `merged` uses the purple state family and `attention` is reserved for what
// waits on the operator.

import type React from 'react';
import { cn } from '../../lib/cn.ts';

export type BadgeVariant =
	| 'default'
	| 'secondary'
	| 'outline'
	| 'info'
	| 'merged'
	| 'success'
	| 'warning'
	| 'error'
	/** Reserved for "waits on the operator", the product's one acid signal. */
	| 'attention';

const SHAPE =
	'relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent font-medium outline-none ' +
	'h-5.5 min-w-5.5 px-[calc(--spacing(1)-1px)] text-sm sm:h-4.5 sm:min-w-4.5 sm:text-xs ' +
	"[&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0";

const VARIANT: Readonly<Record<BadgeVariant, string>> = {
	attention: 'bg-attention text-attention-foreground',
	default: 'bg-primary text-primary-foreground',
	error: 'bg-destructive/8 text-destructive-foreground dark:bg-destructive/16',
	info: 'bg-info/8 text-info-foreground dark:bg-info/16',
	merged: 'bg-merged/8 text-merged-foreground dark:bg-merged/16',
	outline: 'border-input bg-background text-foreground dark:bg-input/32',
	secondary: 'bg-secondary text-secondary-foreground',
	success: 'bg-success/8 text-success-foreground dark:bg-success/16',
	warning: 'bg-warning/8 text-warning-foreground dark:bg-warning/16',
};

export function Badge({
	children,
	variant = 'default',
}: {
	children: React.ReactNode;
	variant?: BadgeVariant;
}): React.ReactElement {
	return (
		<span className={cn(SHAPE, VARIANT[variant])} data-slot="badge">
			{children}
		</span>
	);
}
