// Shared composition roles for groups of cards.  Spacing between sibling
// surfaces belongs here, never to the cards themselves.

import type React from 'react';
import { cn } from '../../lib/cn.ts';

type Container = 'div' | 'ul';
type LayoutProps = {
	as?: Container;
	className?: string;
	children: React.ReactNode;
};

export function CardStack({ as: Tag = 'div', className, children }: LayoutProps): React.ReactElement {
	return <Tag className={cn('flex flex-col gap-6', className)} data-slot="card-stack">{children}</Tag>;
}

export function CardGrid({
	as: Tag = 'div',
	className,
	children,
	compact = false,
	equalHeight = false,
}: LayoutProps & { compact?: boolean; equalHeight?: boolean }): React.ReactElement {
	return (
		<Tag
			className={cn(
				'card-ring-group grid',
				equalHeight && 'auto-rows-fr',
				compact ? 'gap-4' : 'gap-6',
				className,
			)}
			data-density={compact ? 'compact' : 'standard'}
			data-slot="card-grid"
		>
			{children}
		</Tag>
	);
}

/** Two independent card columns which collapse to the normal single column. */
export function CardSplit({ className, children }: Omit<LayoutProps, 'as'>): React.ReactElement {
	return (
		<div
			className={cn('grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]', className)}
			data-slot="card-split"
		>
			{children}
		</div>
	);
}

/** Form rhythm: 12px between fields and 4px within a field. */
export function FormStack({ className, children, ...props }: React.ComponentProps<'form'>): React.ReactElement {
	return <form className={cn('flex flex-col gap-3', className)} data-slot="form-stack" {...props}>{children}</form>;
}

export function FormField({ className, children, ...props }: React.ComponentProps<'label'>): React.ReactElement {
	return <label className={cn('flex flex-col gap-1', className)} data-slot="form-field" {...props}>{children}</label>;
}
