// webui/src/lib/cn.ts
//
// Class composition for this screen, and nothing else: the classes a primitive
// declares, then whatever its call site adds, in that order.
//
// There is deliberately no Tailwind conflict resolution. Every call site here
// adds a property its base does not already set, so no pair of classes competes
// and the resolver would have nothing to do. A future override that DOES
// compete belongs in the primitive as a variant, not in a merge step that
// silently decides which of two utilities the screen meant.

/** What a call site may pass: a class name, or a branch that produced none. */
export type ClassValue = string | false | null | undefined;

/** The truthy class names, in order, separated by a single space. */
export function cn(...values: readonly ClassValue[]): string {
	return values.filter((value): value is string => typeof value === 'string' && value !== '')
		.join(' ');
}
