// webui/src/components/ui/badge.tsx
//
// A short, non-interactive state label. Badges on this screen only ever report
// what the runtime decided -- a run state, a workspace notice kind, which
// provider is in use -- so the component takes a variant and children and
// nothing else: no sizes, no link or button form, no click target.

import type React from 'react';
import { cn } from '../../lib/cn.ts';

/**
 * The families the theme declares. `default` and `secondary` are neutral, the
 * remaining four are the semantic ones a run state maps onto (run-view.ts).
 */
export type BadgeVariant =
	| 'default'
	| 'secondary'
	| 'outline'
	| 'info'
	| 'success'
	| 'warning'
	| 'error';

const SHAPE =
	'inline-flex h-5.5 min-w-5.5 shrink-0 items-center justify-center gap-1 whitespace-nowrap ' +
	'rounded-sm border border-transparent px-[calc(--spacing(1)-1px)] font-medium text-sm ' +
	'sm:h-4.5 sm:min-w-4.5 sm:text-xs';

/**
 * The four semantic families are a tinted wash of their own colour rather than
 * a solid fill, so a row of them reads as status and not as a row of buttons.
 * Dark mode doubles the tint because the same alpha over a dark surface all but
 * disappears.
 */
const VARIANT: Readonly<Record<BadgeVariant, string>> = {
	default: 'bg-primary text-primary-foreground',
	error: 'bg-destructive/8 text-destructive-foreground dark:bg-destructive/16',
	info: 'bg-info/8 text-info-foreground dark:bg-info/16',
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
