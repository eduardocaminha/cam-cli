// webui/src/components/ui/empty-state.tsx
//
// A first-class state, never a blank region (design-system.md section 3): the
// gate mark in a muted tone, one orienting sentence, and at most one action.
// Callers keep owning layout and copy; this component only guarantees an
// empty region still says where the operator is and what comes next.

import type React from 'react';
import { cn } from '../../lib/cn.ts';
import { GateshipMark } from '../gateship-logo.tsx';

export function EmptyState({
	className,
	children,
	action,
	...props
}: React.ComponentProps<'div'> & { action?: React.ReactNode }): React.ReactElement {
	return (
		<div
			className={cn(
				'flex min-h-24 flex-col items-center justify-center gap-3 p-6 text-center',
				className,
			)}
			data-slot="empty-state"
			{...props}
		>
			<span aria-hidden="true">
				<GateshipMark className="size-6 text-muted-foreground/50" />
			</span>
			<p className="max-w-prose text-muted-foreground text-sm">{children}</p>
			{action}
		</div>
	);
}
