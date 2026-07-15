// test/ui/init-setup-screen-keys.test.ts
//
// US-R1-001 (corrects US-002): Verify no duplicate-React-key warnings are
// emitted when the init/setup Ink screens render. The screens are already
// clean: the only dynamic render (checks.map keyed by c.id) uses unique ids by
// design; static NextCommand siblings are reconciled positionally and can never
// produce a duplicate-key warning. This test guards against future regressions
// (e.g. a new dynamic render introducing duplicate key values).
//
// Covers:
//   - InitScreen success path: checks complete, "All set" + "Next" sections visible.
//   - InitScreen failure path: one check fails, "Failed" section + ✗ glyph visible.
//   - SetupScreen existing-project path: all wizard steps completed via keyboard.
//   - SetupScreen new-project path: includes description step.
//
// Implementation note: success/failure in these screens is signalled by the
// glyph (✓ accent / ✗ destructive), never by divider color (patterns.md,
// 2026-06-05 lesson).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';

import { InitScreen } from '../../src/ui/InitScreen.tsx';
import type { CheckDef } from '../../src/ui/InitScreen.tsx';
import { SetupScreen } from '../../src/ui/SetupScreen.tsx';
import { Splash } from '../../src/ui/Splash.tsx';
import { CAM_VERSION } from '../../src/version.ts';
import { waitForFrame } from '../helpers/flush-ink.ts';
import { installTerminalSizeMock } from '../helpers/mock-terminal-size.ts';

// Root-cause fix for stdin-driven Ink render flakiness (CAM-201): stub the
// synchronous `tput` shell-out ink-testing-library's fake stdout otherwise
// triggers on every render (see test/helpers/mock-terminal-size.ts).
installTerminalSizeMock();

// ---------------------------------------------------------------------------
// Shared console.error spy — captures ALL console.error calls across all tests
// in this file. afterAll asserts that none contained a duplicate-key warning.
// ---------------------------------------------------------------------------

const capturedErrors: string[] = [];
const originalConsoleError = console.error;

beforeAll(() => {
	console.error = (...args: unknown[]) => {
		capturedErrors.push(args.map(String).join(' '));
	};
});

afterAll(() => {
	console.error = originalConsoleError;

	const keyWarnings = capturedErrors.filter(
		(e) =>
			e.includes('Encountered two children with the same key') ||
			e.includes('same key'),
	);
	expect(keyWarnings).toEqual([]);
});

// ---------------------------------------------------------------------------
// Test 1: InitScreen — success path
// ---------------------------------------------------------------------------

describe('InitScreen — success path', () => {
	test('renders ✓ glyph and "All set" + "Next" sections when all checks pass', async () => {
		const checks: CheckDef[] = [
			{
				id: 'claude',
				label: 'claude',
				description: 'Required to spawn Claude Code sessions',
				run: () => ({ status: 'ok' as const, detail: 'v2.0.5' }),
			},
			{
				id: 'check-agent-frontmatter',
				label: 'agent-frontmatter',
				description: 'Validates .claude/agents/*.md files',
				run: () => ({ status: 'ok' as const }),
			},
			{
				id: 'config',
				label: 'config',
				description: 'Saves your default permission mode',
				run: () => ({ status: 'ok' as const }),
			},
		];

		// Mirror the exact composition used in src/commands/init.ts:
		// createElement(Box, props, Splash, InitScreen) — variadic children.
		const view = createElement(
			Box,
			{ flexDirection: 'column' },
			createElement(Splash, { version: CAM_VERSION }),
			createElement(InitScreen, { checks, onDone: () => {} }),
		);

		const { lastFrame, unmount } = render(view);

		// Wait for all async checks to complete (each has MIN_RUNNING_MS=140ms
		// delay, plus the setTimeout(onDone, 0) call) by polling for the
		// terminal "All set" section rather than a fixed settle time.
		const frame = await waitForFrame(lastFrame, (f) => f.includes('All set'), {
			timeoutMs: 3000,
		});

		// "All set" section appears only on success.
		expect(frame).toContain('All set');
		// Success is signalled by the ✓ glyph, never by divider color.
		expect(frame).toContain('✓');
		// "Next" section with follow-up commands.
		expect(frame).toContain('Next');
		expect(frame).toContain('cam run');
		expect(frame).toContain('cam plan');

		unmount();
	});
});

// ---------------------------------------------------------------------------
// Test 2: InitScreen — failure path
// ---------------------------------------------------------------------------

describe('InitScreen — failure path', () => {
	test('renders ✗ glyph and "Failed" section when a required check fails', async () => {
		const checks: CheckDef[] = [
			{
				id: 'claude',
				label: 'claude',
				run: () => ({
					status: 'fail' as const,
					detail: 'not found',
					hint: 'Install claude via npm install -g @anthropic-ai/claude-code',
				}),
			},
			{
				id: 'config',
				label: 'config',
				run: () => ({ status: 'ok' as const }),
			},
		];

		const { lastFrame, unmount } = render(
			createElement(InitScreen, { checks, onDone: () => {} }),
		);

		const frame = await waitForFrame(lastFrame, (f) => f.includes('Failed'), {
			timeoutMs: 3000,
		});

		// Failure is signalled by the ✗ glyph; "Failed" section should appear.
		expect(frame).toContain('✗');
		expect(frame).toContain('Failed');
		// Success sections must NOT appear on failure.
		expect(frame).not.toContain('All set');

		unmount();
	});
});

// ---------------------------------------------------------------------------
// Test 3: SetupScreen — existing-project path (keyboard navigation)
// ---------------------------------------------------------------------------

describe('SetupScreen — existing-project path', () => {
	test('renders all wizard sections and the "All set" done state when all steps are answered', async () => {
		let doneCallCount = 0;

		const { lastFrame, stdin, unmount } = render(
			createElement(SetupScreen, {
				prefilled: {},
				onDone: () => {
					doneCallCount += 1;
				},
				onCancel: () => {},
			}),
		);

		// "Project" section is visible immediately.
		const initial = lastFrame() ?? '';
		expect(initial).toContain('Project');

		// Poll for each step's landing marker rather than a fixed tick count:
		// the number of macrotask ticks React needs to settle a state update
		// is not a stable constant across toolchains (CAM-201).
		stdin.write('\r'); // Select mode (existing, the default)
		await waitForFrame(lastFrame, (f) => f.includes('Issue system'));
		stdin.write('\r'); // Select issue system (local, the default)
		await waitForFrame(lastFrame, (f) => f.includes('Merge mode'));
		stdin.write('\r'); // Select merge mode (immediate, the default)
		await waitForFrame(lastFrame, (f) => f.includes('Plan approval'));
		stdin.write('\r'); // Select plan approval (auto, the default)

		// Allow the done setTimeout to fire.
		const frame = await waitForFrame(lastFrame, (f) => f.includes('All set'));
		expect(frame).toContain('All set');
		expect(frame).toContain('✓');
		expect(frame).toContain('Next');

		unmount();
	});
});

// ---------------------------------------------------------------------------
// Test 4: SetupScreen — new-project path (includes description step)
// ---------------------------------------------------------------------------

describe('SetupScreen — new-project path', () => {
	test('navigates to the description step when project mode is "new" and completes', async () => {
		const { lastFrame, stdin, unmount } = render(
			createElement(SetupScreen, {
				prefilled: {},
				onDone: () => {},
				onCancel: () => {},
			}),
		);

		// Down arrow selects "New project" (second option in MODE_OPTIONS).
		// Poll for each step's landing marker rather than a fixed tick count:
		// the number of macrotask ticks React needs to settle a state update
		// is not a stable constant across toolchains (CAM-201).
		stdin.write('\x1b[B');
		await waitForFrame(lastFrame, (f) => f.includes('❯ New project'));
		stdin.write('\r'); // Confirm "New project"
		await waitForFrame(lastFrame, (f) => f.includes('Issue system'));
		stdin.write('\r'); // Confirm issue system
		await waitForFrame(lastFrame, (f) => f.includes('Merge mode'));
		stdin.write('\r'); // Confirm merge mode
		await waitForFrame(lastFrame, (f) => f.includes('Plan approval'));
		stdin.write('\r'); // Confirm plan approval
		await waitForFrame(lastFrame, (f) => f.includes('Project summary'));
		// Description text-input: pressing Enter with empty draft confirms and skips.
		stdin.write('\r');
		const frame = await waitForFrame(lastFrame, (f) => f.includes('All set'));
		// "All set" should appear at the end of the wizard.
		expect(frame).toContain('All set');
		expect(frame).toContain('✓');

		unmount();
	});
});
