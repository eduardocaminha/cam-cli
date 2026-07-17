// test/ui/splash.test.tsx
//
// US-001: uppercase "CAM" block wordmark + "Runtime" line + Fir Green brand
// accent in the splash panel. Renders the REAL Splash component via
// ink-testing-library and inspects the frame (not header comments), per the
// project invariant: never assert behavior from a comment.

import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { render } from 'ink-testing-library';

import { Splash } from '../../src/ui/Splash.tsx';
import { waitForFrame } from '../helpers/flush-ink.ts';
import { installTerminalSizeMock } from '../helpers/mock-terminal-size.ts';

installTerminalSizeMock();

describe('Splash', () => {
	test('renders the bordered panel, uppercase wordmark, Runtime line, tagline and version/url line', async () => {
		const { lastFrame, unmount } = render(
			createElement(Splash, { version: '9.9.9' }),
		);

		const frame = await waitForFrame(lastFrame, (f) => f.includes('Runtime'));

		// Bordered panel (rounded border corners from Ink's `borderStyle="round"`).
		expect(frame).toContain('╭');
		expect(frame).toContain('╮');
		expect(frame).toContain('╰');
		expect(frame).toContain('╯');

		// Uppercase "CAM" block wordmark rows are present (block glyph rows).
		expect(frame).toContain('█████');

		// Styled "Runtime" line renders below the wordmark.
		expect(frame).toContain('Runtime');

		// Tagline + version/url line still render.
		expect(frame).toContain('Autonomous Claude Code loop');
		expect(frame).toContain('powered by your subscription');
		expect(frame).toContain('v9.9.9');
		expect(frame).toContain('eduardocaminha/cam-cli');

		unmount();
	});

	test('supports a custom tagline and url', async () => {
		const { lastFrame, unmount } = render(
			createElement(Splash, {
				version: '1.0.0',
				url: 'example/repo',
				tagline: ['custom line one', 'custom line two'],
			}),
		);

		const frame = await waitForFrame(lastFrame, (f) =>
			f.includes('custom line one'),
		);

		expect(frame).toContain('custom line one');
		expect(frame).toContain('custom line two');
		expect(frame).toContain('example/repo');

		unmount();
	});
});
