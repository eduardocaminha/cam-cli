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
	compact = false,
	...props
}: React.ComponentProps<'div'> & { action?: React.ReactNode; compact?: boolean }): React.ReactElement {
	return (
		<div
			className={cn(
				compact
					? 'flex items-center gap-2 py-1 text-left'
					: 'flex min-h-24 flex-col items-center justify-center gap-3 p-6 text-center',
				className,
			)}
			data-density={compact ? 'compact' : 'default'}
			data-slot="empty-state"
			{...props}
		>
			<span aria-hidden="true">
				<GateshipMark className={cn('text-muted-foreground/50', compact ? 'size-4' : 'size-6')} />
			</span>
			<p className="max-w-prose text-muted-foreground text-sm">{children}</p>
			{action}
		</div>
	);
}
