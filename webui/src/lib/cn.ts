// webui/src/lib/cn.ts
//
// Class composition for this screen: clsx flattens the truthy inputs and
// tailwind-merge resolves competing utilities in favour of the caller.
//
// The previous version deliberately skipped conflict resolution because no
// call site competed with its base. That held while every primitive was
// written here; it stops holding with shadcn-style components, whose variant
// system leans on the caller overriding base utilities (operator decision,
// 2026-08-24). Composition order is unchanged: base classes first, call-site
// classes last.

import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** What a call site may pass: a class name, or a branch that produced none. */
export type ClassValue = string | false | null | undefined;

/** The truthy class names in order, with conflicting utilities resolved. */
export function cn(...values: readonly ClassValue[]): string {
	return twMerge(clsx(values));
}
