// webui/src/components/ui/textarea.tsx
//
// Gateship's textarea uses the same composed control as
// Input -- a span wrapper with the chrome, the field inside bare -- with
// content-driven sizing. The focus ring stays Gateship's acid --ring token.

import type React from 'react';
import { cn } from '../../lib/cn.ts';

const WRAPPER =
	'relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base shadow-xs/5 ring-ring/24 transition-shadow ' +
	'before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] ' +
	'not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] ' +
	'has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 ' +
	'has-aria-invalid:border-destructive/36 has-focus-visible:border-ring ' +
	'has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] ' +
	'sm:text-sm dark:bg-input/32 dark:has-aria-invalid:ring-destructive/24 ' +
	'dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]';

const INNER =
	'field-sizing-content min-h-17.5 w-full resize-none rounded-[inherit] px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] ' +
	'text-foreground outline-none placeholder:text-muted-foreground/72 max-sm:min-h-20.5';

export function Textarea({
	className,
	...props
}: React.ComponentProps<'textarea'>): React.ReactElement {
	return (
		<span className={cn(WRAPPER, className)} data-slot="textarea-control">
			<textarea className={INNER} data-slot="textarea" {...props} />
		</span>
	);
}
