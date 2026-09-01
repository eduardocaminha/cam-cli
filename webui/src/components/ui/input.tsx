// webui/src/components/ui/input.tsx
//
// coss ui's input, vendored verbatim (packages/ui/src/components/input.tsx,
// operator decision 2026-08-25): a span wrapper carries the visual chrome
// (rounded-lg border, hairline bevel, bevel and shadow dropping away while
// focused) and the real input inside stays bare. The focus ring stays
// Gateship's acid --ring token.

import { Input as InputPrimitive } from '@base-ui/react/input';
import type React from 'react';
import { cn } from '../../lib/cn.ts';

const WRAPPER =
	'relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base shadow-xs/5 ring-ring/24 transition-shadow ' +
	'before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] ' +
	'not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] ' +
	'has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 ' +
	'has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-autofill:bg-foreground/4 ' +
	'has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] ' +
	'sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 ' +
	'dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]';

const INNER =
	'h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] text-foreground leading-8.5 outline-none ' +
	'[transition:background-color_5000000s_ease-in-out_0s] placeholder:text-muted-foreground/72 ' +
	'sm:h-7.5 sm:leading-7.5 autofill:[-webkit-text-fill-color:var(--foreground)]';

export function Input({
	className,
	...props
}: Omit<InputPrimitive.Props, 'className'> & { className?: string }): React.ReactElement {
	return (
		<span className={cn(WRAPPER, className)} data-slot="input-control">
			<InputPrimitive className={INNER} data-slot="input" {...props} />
		</span>
	);
}
