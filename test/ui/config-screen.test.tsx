// test/ui/config-screen.test.tsx
//
// US-001 (CAM-286, CAM-287): ConfigScreen render assertions for the
// reconciled MODEL_OPTIONS list. Guards that the picker still renders
// correctly (model select step shows the sonnet tier alias option, and
// success is still signalled by the ✓ glyph, never divider color) after
// DEFAULTS and MODEL_OPTIONS were reconciled to CLI tier aliases (ADR-0034).
//
// US-002 (CAM-287): the model-select step also offers a free-text
// 'custom / enter id' passthrough (ink-text-input) for pinning an arbitrary
// model value (e.g. a dated snapshot or an unreleased id) verbatim.

import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { render } from 'ink-testing-library';

import { ConfigScreen, MODEL_OPTIONS } from '../../src/ui/ConfigScreen.tsx';
import type { ConfigChoices } from '../../src/ui/ConfigScreen.tsx';
import { waitForFrame } from '../helpers/flush-ink.ts';
import { installTerminalSizeMock } from '../helpers/mock-terminal-size.ts';

installTerminalSizeMock();

describe('ConfigScreen — reconciled MODEL_OPTIONS', () => {
	test('the first model-select step lists every MODEL_OPTIONS entry, including the sonnet tier alias', () => {
		const { lastFrame, unmount } = render(
			createElement(ConfigScreen, { onDone: () => {}, onCancel: () => {} }),
		);

		const frame = lastFrame() ?? '';
		for (const option of MODEL_OPTIONS) {
			expect(frame).toContain(option.label);
		}
		expect(frame).toContain('sonnet');

		unmount();
	});

	test('confirming a step signals success via the ✓ glyph, never divider color', async () => {
		const { lastFrame, stdin, unmount } = render(
			createElement(ConfigScreen, { onDone: () => {}, onCancel: () => {} }),
		);

		stdin.write('\r'); // confirm orchestrator's default model
		const frame = await waitForFrame(lastFrame, (f) => f.includes('✓'));
		expect(frame).toContain('✓');

		unmount();
	});

	test('completing the wizard writes the reconciled default implementer model (sonnet)', async () => {
		let choices: ConfigChoices | undefined;

		const { lastFrame, stdin, unmount } = render(
			createElement(ConfigScreen, {
				onDone: (c: ConfigChoices) => {
					choices = c;
				},
				onCancel: () => {},
			}),
		);

		// 6 phase steps + backend + merge-mode + plan-approval = 9 confirmations.
		for (let i = 0; i < 9; i += 1) {
			stdin.write('\r');
			await waitForFrame(lastFrame, () => true, { timeoutMs: 200 });
		}

		const frame = await waitForFrame(lastFrame, (f) => f.includes('Configuration written'));
		expect(frame).toContain('Configuration written to scripts/cam/project.toml');
		expect(frame).toContain('✓');

		// onDone fires via a setTimeout(0) after the "done" step commits; give it
		// a further tick to land before asserting on the captured choices.
		await waitForFrame(() => (choices ? 'done' : ''), (f) => f === 'done');
		expect(choices?.models.implementer).toBe('sonnet');

		unmount();
	});
});

describe('ConfigScreen — custom / enter id passthrough (US-002)', () => {
	test('the model-select step offers a custom / enter id entry that reveals a free-text input', async () => {
		const { lastFrame, stdin, unmount } = render(
			createElement(ConfigScreen, { onDone: () => {}, onCancel: () => {} }),
		);

		let frame = lastFrame() ?? '';
		expect(frame).toContain('custom / enter id');

		// Down-arrow past all 8 MODEL_OPTIONS entries to reach the custom row
		// (defaultValue 'opus' starts at idx 0).
		for (let i = 0; i < MODEL_OPTIONS.length; i += 1) {
			stdin.write('\x1b[B');
		}
		frame = await waitForFrame(lastFrame, (f) => f.includes('❯ custom / enter id'));
		expect(frame).toContain('❯ custom / enter id');

		stdin.write('\r'); // choose the custom entry
		frame = await waitForFrame(lastFrame, (f) => f.includes('Enter a model id'));
		expect(frame).toContain('Enter a model id');

		unmount();
	});

	test('a typed dated-snapshot id is stored verbatim and shown in the confirmed summary', async () => {
		let choices: ConfigChoices | undefined;
		const { lastFrame, stdin, unmount } = render(
			createElement(ConfigScreen, {
				onDone: (c: ConfigChoices) => {
					choices = c;
				},
				onCancel: () => {},
			}),
		);

		for (let i = 0; i < MODEL_OPTIONS.length; i += 1) {
			stdin.write('\x1b[B');
		}
		await waitForFrame(lastFrame, (f) => f.includes('❯ custom / enter id'));
		stdin.write('\r'); // reveal the free-text input
		await waitForFrame(lastFrame, (f) => f.includes('Enter a model id'));

		const pinnedId = 'claude-sonnet-4-5-20250929';
		stdin.write(pinnedId);
		await waitForFrame(lastFrame, (f) => f.includes(pinnedId)); // typed text lands in the TextInput
		stdin.write('\r'); // confirm

		let frame = await waitForFrame(lastFrame, (f) => f.includes('✓'));
		expect(frame).toContain('✓');
		expect(frame).toContain(pinnedId);

		// Advance through the remaining 5 phase steps + backend + merge-mode +
		// plan-approval (8 confirmations) with defaults to reach 'done'.
		for (let i = 0; i < 8; i += 1) {
			stdin.write('\r');
			await waitForFrame(lastFrame, () => true, { timeoutMs: 200 });
		}
		frame = await waitForFrame(lastFrame, (f) => f.includes('Configuration written'));
		expect(frame).toContain('Configuration written to scripts/cam/project.toml');

		await waitForFrame(() => (choices ? 'done' : ''), (f) => f === 'done');
		expect(choices?.models.orchestrator).toBe(pinnedId);

		unmount();
	});

	test('selecting a normal alias entry still advances the wizard as before (no custom-path regression)', async () => {
		const { lastFrame, stdin, unmount } = render(
			createElement(ConfigScreen, { onDone: () => {}, onCancel: () => {} }),
		);

		stdin.write('\x1b[B'); // move to 'sonnet' (idx 1), not the custom entry
		let frame = await waitForFrame(lastFrame, (f) => f.includes('❯ sonnet'));
		expect(frame).toContain('❯ sonnet');

		stdin.write('\r'); // confirm the alias
		frame = await waitForFrame(lastFrame, (f) => f.includes('✓ sonnet'));
		expect(frame).toContain('✓ sonnet');
		expect(frame).not.toContain('Enter a model id');

		unmount();
	});
});
