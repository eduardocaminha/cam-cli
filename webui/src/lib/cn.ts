// webui/src/lib/cn.ts
//
// Class composition for this screen: clsx flattens the truthy inputs and
// tailwind-merge resolves competing utilities in favour of the caller.
//
// Component variants let callers override base utilities. Composition order
// stays base classes first, call-site classes last.

import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** What a call site may pass: a class name, or a branch that produced none. */
export type ClassValue = string | false | null | undefined;

/** The truthy class names in order, with conflicting utilities resolved. */
export function cn(...values: readonly ClassValue[]): string {
	return twMerge(clsx(values));
}
