// webui/src/components/ui/attention-card.tsx
//
// The only acid surface in the product. Acid marks exactly one thing: an item
// waiting on the operator (design-system.md section 1), so this card is the
// loudest element on any screen it appears on, and nothing else may use the
// attention family as a surface. Healthy activity stays monochrome.
//
// The border uses the -ui ramp so it holds 3:1 on the light canvas; on dark
// the ramp is pure acid. The pulse honours reduced motion via motion-safe.

import type React from 'react';
import { cn } from '../../lib/cn.ts';

const SHAPE =
	'flex flex-col gap-2 rounded-2xl border border-attention-ui bg-attention-surface p-4 ' +
	'shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_2px_3px_rgba(0,0,0,0.05),0_6px_28px_rgba(200,255,0,0.09)] ' +
	'dark:shadow-[0_2px_3px_rgba(0,0,0,0.3),0_6px_28px_rgba(200,255,0,0.09)] ';

export function AttentionCard({
	title,
	className,
	children,
	...props
}: React.ComponentProps<'section'> & { title: React.ReactNode }): React.ReactElement {
	return (
		<section className={cn(SHAPE, className)} data-slot="attention-card" {...props}>
			<div className="flex items-center gap-2">
				<span
					aria-hidden="true"
					className="size-2 shrink-0 rounded-full bg-attention-ui motion-safe:animate-pulse"
				/>
				<p className="font-medium text-sm">{title}</p>
			</div>
			{children}
		</section>
	);
}
