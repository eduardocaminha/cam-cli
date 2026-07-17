// test/ui/tab-bar.test.tsx
//
// US-003 (CAM-241/153): TabBar chip component. Covers:
//   - one chip rendered per provided tab label
//   - active tab highlighted (accent glyph via bold [ ... ] chip), moved by
//     Left/Right (wrap-around at the bounds)
//   - confirmed tabs render "label: value"; unconfirmed tabs render the
//     label only
//   - success/failure is signalled by the glyph, never divider color
//     (curated invariant): this component has no divider, only the chip
//     brackets + accent/muted coloring, so we assert on chip text content.
//
// US-001 (CAM-241/326): direct `suspended` prop coverage, independent of
// ConfigScreen (its single caller). See the "suspended prop" describe block
// below.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createElement, useState } from 'react';
import { render } from 'ink-testing-library';
import chalk, { type ColorSupportLevel } from 'chalk';

import { TabBar } from '../../src/ui/TabBar.tsx';
import type { TabDef } from '../../src/ui/TabBar.tsx';
import { colors } from '../../src/ui/theme.ts';
import { waitForFrame } from '../helpers/flush-ink.ts';
import { installTerminalSizeMock } from '../helpers/mock-terminal-size.ts';

installTerminalSizeMock();

const TABS: TabDef[] = [
	{ label: 'Orchestrator', confirmed: true, value: 'opus' },
	{ label: 'Planner', confirmed: false },
	{ label: 'Global' },
];

/** Stateful wrapper: TabBar is a pure controlled component, so tests own the
 * `activeIndex` state and thread it back in via `onChange`, exactly the way
 * ConfigScreen (US-004) will. */
function ControlledTabBar({
	tabs,
	initialIndex = 0,
}: {
	tabs: TabDef[];
	initialIndex?: number;
}) {
	const [activeIndex, setActiveIndex] = useState(initialIndex);
	return createElement(TabBar, { tabs, activeIndex, onChange: setActiveIndex });
}

/** Same stateful wrapper, but threads `suspended` through to TabBar so
 * US-001 (CAM-241/326) can pin the presentational suspend contract directly,
 * independent of ConfigScreen's own `textInputFocused` derivation. */
function ControlledTabBarWithSuspend({
	tabs,
	initialIndex = 0,
	suspended,
}: {
	tabs: TabDef[];
	initialIndex?: number;
	suspended: boolean;
}) {
	const [activeIndex, setActiveIndex] = useState(initialIndex);
	return createElement(TabBar, { tabs, activeIndex, onChange: setActiveIndex, suspended });
}

describe('TabBar', () => {
	test('renders one chip per tab label', () => {
		const { lastFrame, unmount } = render(createElement(ControlledTabBar, { tabs: TABS }));

		const frame = lastFrame() ?? '';
		expect(frame).toContain('Orchestrator');
		expect(frame).toContain('Planner');
		expect(frame).toContain('Global');

		unmount();
	});

	test('confirmed tabs render "label: value"; unconfirmed tabs render the label only', () => {
		const { lastFrame, unmount } = render(createElement(ControlledTabBar, { tabs: TABS }));

		const frame = lastFrame() ?? '';
		expect(frame).toContain('Orchestrator: opus');
		expect(frame).toContain('Planner');
		expect(frame).not.toContain('Planner:');

		unmount();
	});

	test('Right arrow moves the active tab forward', async () => {
		const { lastFrame, stdin, unmount } = render(createElement(ControlledTabBar, { tabs: TABS }));

		stdin.write('[C'); // Right
		const frame = await waitForFrame(lastFrame, (f) => f.includes('[ Planner ]'));
		expect(frame).toContain('[ Planner ]');

		unmount();
	});

	test('Left arrow from the first tab wraps to the last tab', async () => {
		const { lastFrame, stdin, unmount } = render(createElement(ControlledTabBar, { tabs: TABS }));

		stdin.write('[D'); // Left, wraps from idx 0 to idx (length - 1)
		const frame = await waitForFrame(lastFrame, (f) => f.includes('[ Global ]'));
		expect(frame).toContain('[ Global ]');

		unmount();
	});

	test('Right arrow from the last tab wraps to the first tab', async () => {
		const { lastFrame, stdin, unmount } = render(
			createElement(ControlledTabBar, { tabs: TABS, initialIndex: TABS.length - 1 }),
		);

		let frame = lastFrame() ?? '';
		expect(frame).toContain('[ Global ]');

		stdin.write('[C'); // Right, wraps from the last idx to idx 0
		frame = await waitForFrame(lastFrame, (f) => f.includes('[ Orchestrator: opus ]'));
		expect(frame).toContain('[ Orchestrator: opus ]');

		unmount();
	});
});

// --- suspended prop (US-001, CAM-241/316) -----------------------------------
//
// The active chip's ONLY visible marker is bold + accent color (TabChip has
// no divider, per the curated Ink success/failure invariant); ink-testing-
// library's fake stdout otherwise renders through chalk with color support
// disabled (no TTY), so plain chip-text assertions alone can't distinguish
// which tab is active (every chip's bracket text renders regardless of
// index). Force `chalk.level = 3` for this block -- the same technique
// already established in test/ui/dashboard-story-row.test.tsx -- so the
// active chip's accent+bold ANSI wrapping actually appears in `lastFrame()`
// and the suspend/navigate contract is pinned against real observable
// output, not a tautological mock-call check.
describe('TabBar suspended prop (US-001, CAM-241/316)', () => {
	let savedChalkLevel: ColorSupportLevel;

	beforeAll(() => {
		savedChalkLevel = chalk.level;
		chalk.level = 3;
	});

	afterAll(() => {
		chalk.level = savedChalkLevel;
	});

	/** The exact ANSI-wrapped substring TabChip renders for the active chip
	 * (bold + accent color), so `toContain`/`not.toContain` pins which tab is
	 * actually active rather than just checking the label text is present. */
	const activeChip = (text: string): string => chalk.bold(chalk.hex(colors.accent)(text));

	test('with suspended={false}, Right arrow still fires tab navigation', async () => {
		const { lastFrame, stdin, unmount } = render(
			createElement(ControlledTabBarWithSuspend, { tabs: TABS, suspended: false }),
		);

		let frame = lastFrame() ?? '';
		expect(frame).toContain(activeChip('[ Orchestrator: opus ]'));

		stdin.write('[C'); // Right
		frame = await waitForFrame(lastFrame, (f) => f.includes(activeChip('[ Planner ]')));
		expect(frame).toContain(activeChip('[ Planner ]'));
		expect(frame).not.toContain(activeChip('[ Orchestrator: opus ]'));

		unmount();
	});

	test('with suspended={true}, Left/Right arrows are suppressed and do not change the active tab', async () => {
		const { lastFrame, stdin, unmount } = render(
			createElement(ControlledTabBarWithSuspend, { tabs: TABS, suspended: true }),
		);

		const initialFrame = lastFrame() ?? '';
		expect(initialFrame).toContain(activeChip('[ Orchestrator: opus ]'));

		stdin.write('[C'); // Right, should be suppressed (isActive: false via suspended)
		stdin.write('[D'); // Left, should also be suppressed
		// No state-changing side effect is expected, so there is no predicate
		// to poll FOR (nothing is expected to become true). But the window
		// still has to be genuinely consumed by polling, not short-
		// circuited: an always-true predicate returns on the very first
		// check (0 macrotask ticks), which would let a suspension
		// regression's not-yet-flushed state update slip past the
		// assertion undetected. Use an always-false predicate instead, so
		// `waitForFrame` polls for the full `timeoutMs` window (real
		// event-loop turns), then assert content-persistence (per the
		// curated no-tautological-mock-assertion invariant: we assert the
		// observable rendered frame, not a mock call count).
		await waitForFrame(lastFrame, () => false, { timeoutMs: 200 });
		const settledFrame = lastFrame() ?? '';
		expect(settledFrame).toContain(activeChip('[ Orchestrator: opus ]'));
		expect(settledFrame).not.toContain(activeChip('[ Planner ]'));
		expect(settledFrame).not.toContain(activeChip('[ Global ]'));

		unmount();
	});
});
