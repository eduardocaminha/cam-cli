// webui/src/components/ui/callout.tsx
//
// An inline notice inside a surface, on coss ui's alert recipe (packages/ui
// /src/components/alert.tsx, operator decision 2026-08-25): a rounded-xl
// box whose tone is a 32% border and 4% wash of its own hue, with the text
// staying the surface's ink -- the frame carries the state, the words stay
// readable. Tones map to the state families; neutral is for facts that are
// not states. Never acid: what waits on the operator has its own surface
// (attention-card.tsx).

import type React from 'react';
import { cn } from '../../lib/cn.ts';

export type CalloutTone = 'neutral' | 'success' | 'warning' | 'destructive';

const TONE: Readonly<Record<CalloutTone, string>> = {
	neutral: 'bg-transparent dark:bg-input/32',
	success: 'border-success/32 bg-success/4',
	warning: 'border-warning/32 bg-warning/4',
	destructive: 'border-destructive/32 bg-destructive/4',
};

export function Callout({
	tone = 'neutral',
	title,
	className,
	children,
	...props
}: React.ComponentProps<'section'> & {
	tone?: CalloutTone;
	title?: React.ReactNode;
}): React.ReactElement {
	return (
		<section
			className={cn(
				'relative flex w-full flex-col gap-y-0.5 rounded-xl border px-3.5 py-3 text-card-foreground text-sm',
				TONE[tone],
				className,
			)}
			data-slot="callout"
			{...props}
		>
			{title === undefined ? null : <p className="font-medium">{title}</p>}
			{children}
		</section>
	);
}
