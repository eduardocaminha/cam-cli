// src/ui/promptSelect.tsx
//
// Async wrapper around the Ink `Select` component for one-off operator
// prompts inside otherwise-linear CLI flows (resume reconciliation, plan
// approval). Mounts Ink long enough to capture one selection, then
// unmounts and resolves with the chosen value (or `null` on Esc).
//
// Callers are expected to be in an interactive TTY — the function does not
// fall back to a text prompt. Non-TTY callers should branch on
// `isInteractiveTTY()` themselves and use the synchronous text path.

import { createElement } from 'react';
import { render } from 'ink';

import { Select, type SelectOption } from './Select.tsx';

export interface PromptSelectArgs<T extends string> {
	/** Question rendered above the option list. */
	question: string;
	/** Options to choose from. Same shape used by SetupScreen. */
	options: readonly SelectOption<T>[];
	/** Value to seed the cursor on. Defaults to the first option. */
	defaultValue?: T;
}

/**
 * Resolve with the operator's selected value, or `null` if they hit Esc.
 * The Ink instance is unmounted before the promise resolves so callers can
 * safely emit further linear prints right after `await promptSelect(...)`.
 */
export async function promptSelect<T extends string>(
	args: PromptSelectArgs<T>,
): Promise<T | null> {
	return new Promise((resolve) => {
		let instance: ReturnType<typeof render>;
		let resolved = false;
		const finish = (value: T | null): void => {
			if (resolved) return;
			resolved = true;
			instance.unmount();
			resolve(value);
		};
		const view = createElement(Select<T>, {
			question: args.question,
			options: args.options,
			defaultValue: args.defaultValue,
			onChange: (value: T) => finish(value),
			onCancel: () => finish(null),
		});
		instance = render(view);
	});
}
