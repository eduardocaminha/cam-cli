// test/ui/dashboard-story-row.test.tsx
//
// US-001: long story titles in the Stories list must truncate to a fixed
// width with a trailing ellipsis so a title never wraps and interleaves with
// the per-story tokens text. Covers both StoryRow render variants (selected
// accent-background row, unselected flex row), the pure `truncateTitle`
// helper directly, short titles rendering unchanged, and the detail subview
// (Enter) still showing the full untruncated title.
//
// Rendered with ink-testing-library so assertions are against the ACTUAL
// screen output, not a comment about it (project lesson 2026-06-05). Story
// state stays signalled by the glyph (✓/→/◌), never the divider color.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { render } from 'ink-testing-library';
import chalk, { type ColorSupportLevel } from 'chalk';

import { DashboardApp, STORY_TOKENS_PLACEHOLDER, truncateTitle } from '../../src/ui/Dashboard.tsx';
import type { DashboardData } from '../../src/commands/dashboard.ts';
import { waitForFrame } from '../helpers/flush-ink.ts';
import { installTerminalSizeMock } from '../helpers/mock-terminal-size.ts';

installTerminalSizeMock();

const LONG_TITLE =
	'This is a deliberately long story title that exceeds the fixed row budget and must be truncated with a trailing ellipsis';
const SHORT_TITLE = 'Short title within budget';

function makeData(overrides: Partial<DashboardData> = {}): DashboardData {
	return {
		branchName: 'cam/test',
		currentStoryId: '',
		currentStoryTitle: '',
		iteration: 0,
		maxIterations: 30,
		startedAtMs: 0,
		nowMs: 0,
		paused: false,
		idle: false,
		recent: [],
		stories: [],
		storyTokens: {},
		...overrides,
	};
}

// --- truncateTitle (pure helper) --------------------------------------------

describe('truncateTitle (pure helper, US-001)', () => {
	it('returns the title unchanged when within budget', () => {
		expect(truncateTitle('short', 10)).toBe('short');
	});

	it('returns the title unchanged when exactly at budget (no ellipsis)', () => {
		expect(truncateTitle('1234567890', 10)).toBe('1234567890');
	});

	it('cuts with a trailing ellipsis when the title exceeds budget', () => {
		expect(truncateTitle('12345678901', 10)).toBe('123456789…');
	});

	it('never crashes on an empty title', () => {
		expect(truncateTitle('', 10)).toBe('');
	});
});

// --- StoryRow rendering (ink-testing-library) -------------------------------

describe('StoryRow title truncation (US-001)', () => {
	let savedChalkLevel: ColorSupportLevel;

	beforeAll(() => {
		savedChalkLevel = chalk.level;
		chalk.level = 3;
	});

	afterAll(() => {
		chalk.level = savedChalkLevel;
	});

	it('selected row: long title truncates with an ellipsis; tokens stay on the same line', () => {
		const data = makeData({
			currentStoryId: 'US-001',
			stories: [{ id: 'US-001', title: LONG_TITLE, priority: 1, passes: false }],
		});
		const { lastFrame, unmount } = render(
			<DashboardApp readSnapshot={() => data} pollIntervalMs={100_000} runTmux={() => undefined} />,
		);
		const frame = lastFrame() ?? '';
		expect(frame).not.toContain(LONG_TITLE);
		expect(frame).toContain('…');
		// Match the Stories list row specifically (not the Loop panel's
		// "story    US-001" summary line): only the list row carries the
		// tokens placeholder/rendered tokens next to the id.
		const line = frame.split('\n').find((l) => l.includes('US-001') && l.includes(STORY_TOKENS_PLACEHOLDER));
		expect(line).toBeDefined();
		unmount();
	});

	it('unselected row: long title truncates with an ellipsis; tokens stay on the same line', () => {
		const data = makeData({
			currentStoryId: 'US-002',
			stories: [
				{ id: 'US-001', title: LONG_TITLE, priority: 1, passes: true },
				{ id: 'US-002', title: 'second', priority: 2, passes: false },
			],
		});
		const { lastFrame, unmount } = render(
			<DashboardApp readSnapshot={() => data} pollIntervalMs={100_000} runTmux={() => undefined} />,
		);
		const frame = lastFrame() ?? '';
		expect(frame).not.toContain(LONG_TITLE);
		const line = frame.split('\n').find((l) => l.includes('US-001') && l.includes(STORY_TOKENS_PLACEHOLDER));
		expect(line).toBeDefined();
		unmount();
	});

	it('short titles (within budget) render unchanged, no ellipsis appended', () => {
		const data = makeData({
			currentStoryId: 'US-001',
			stories: [{ id: 'US-001', title: SHORT_TITLE, priority: 1, passes: false }],
		});
		const { lastFrame, unmount } = render(
			<DashboardApp readSnapshot={() => data} pollIntervalMs={100_000} runTmux={() => undefined} />,
		);
		const frame = lastFrame() ?? '';
		expect(frame).toContain(SHORT_TITLE);
		const line = frame.split('\n').find((l) => l.includes('US-001') && l.includes(STORY_TOKENS_PLACEHOLDER));
		expect(line).toBeDefined();
		expect(line).not.toContain('…');
		unmount();
	});

	it('detail subview (Enter) still shows the full untruncated title', async () => {
		const data = makeData({
			currentStoryId: 'US-001',
			stories: [{ id: 'US-001', title: LONG_TITLE, priority: 1, passes: false, acceptanceCriteria: [] }],
		});
		const { lastFrame, stdin, unmount } = render(
			<DashboardApp readSnapshot={() => data} pollIntervalMs={100_000} runTmux={() => undefined} />,
		);
		stdin.write('\r');
		const frame = await waitForFrame(lastFrame, (f) => f.includes('back to list'));
		// The detail view word-wraps the (intentionally untruncated) long title
		// across terminal lines; normalize wrap-induced line breaks back to a
		// single space before asserting the full title text is present verbatim.
		const normalized = frame.replace(/\n\s+/g, ' ');
		expect(normalized).toContain(LONG_TITLE);
		unmount();
	});
});
