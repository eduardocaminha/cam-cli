// test/ui/config-screen.test.tsx
//
// US-001 (CAM-286, CAM-287): ConfigScreen render assertions for the
// reconciled MODEL_OPTIONS list. Guards that the picker still renders
// correctly (model select step shows the sonnet tier alias option, and
// success is still signalled by the ✓ glyph, never divider color) after
// DEFAULTS and MODEL_OPTIONS were reconciled to CLI tier aliases (ADR-0034).

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
