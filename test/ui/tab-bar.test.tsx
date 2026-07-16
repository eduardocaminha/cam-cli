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

import { describe, expect, test } from 'bun:test';
import { createElement, useState } from 'react';
import { render } from 'ink-testing-library';

import { TabBar } from '../../src/ui/TabBar.tsx';
import type { TabDef } from '../../src/ui/TabBar.tsx';
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
