// test/ui/config-screen.test.tsx
//
// US-004 (CAM-241/153): ConfigScreen refactored to a TabBar-driven tabbed UI
// (7 tabs: 6 phases + Global), replacing the sequential forward-only wizard.
// Covers AC1-AC7 of that story.
//
// US-003 (CAM-349, ADR-0046): backend widened from a single Global-tab field
// to a per-phase Select (mirroring the model/effort Selects), rendered on
// each of the 6 phase tabs. The Global tab no longer has a Backend section.
//
// GOTCHA (discovered while writing these tests): a raw arrow-key CSI sequence
// needs the leading ESC byte (`\x1b[C`) to be recognized by Ink's keypress
// parser (`ink/build/parse-keypress.js`'s `fnKeyRe` requires `^\x1b+`); a
// sequence missing the ESC prefix (e.g. `'[C'`) parses to an empty key name
// and is a silent no-op. Assertions that only check a tab chip's label text
// (e.g. `frame.includes('[ Planner ]')`) are also NOT a reliable signal that
// the keypress worked, because TabBar always renders every chip's label
// regardless of which tab is active (only the color differs). The
// non-tautological way to assert "tab N is now active" is to check for
// content that only renders when that tab's own Section is mounted (e.g. the
// `Model for <phase>:` / `Effort for <phase>:` / `Backend for <phase>:`
// question text, which disappears once a field is confirmed) -- content
// unique to the previous tab's Section must also be asserted ABSENT, since
// only the active tab's content is mounted at all.

import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { render } from 'ink-testing-library';

import { ConfigScreen, MODEL_OPTIONS, computeNextFocus, buildTabDefs } from '../../src/ui/ConfigScreen.tsx';
import type { ConfigChoices } from '../../src/ui/ConfigScreen.tsx';
import { EFFORT_DEFAULTS, DEFAULTS } from '../../src/config/models.ts';
import type { Phase } from '../../src/config/models.ts';
import { waitForFrame } from '../helpers/flush-ink.ts';
import { installTerminalSizeMock } from '../helpers/mock-terminal-size.ts';

installTerminalSizeMock();

const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';
const DOWN = '\x1b[B';
const TAB = '\t';
const ENTER = '\r';

const ALL_PHASES: readonly Phase[] = ['orchestrator', 'planner', 'auditor', 'implementer', 'reviewer', 'ship'];

// Total (tab, field) positions across all 7 tabs: 5 LLM phases * 3 fields
// (model, effort, backend) + ship's 2 fields (model, backend) + Global's 4
// fields (merge-mode, plan-approval, notify recipient, notify from) = 21.
// Advancing past the last one fires onDone (see computeNextFocus).
const TOTAL_FIELD_COUNT = 5 * 3 + 2 + 4;

function renderConfig(onDone: (c: ConfigChoices) => void = () => {}) {
	return render(createElement(ConfigScreen, { onDone, onCancel: () => {} }));
}

describe('ConfigScreen — 7-tab layout (AC1)', () => {
	test('renders all 6 phase tabs plus the Global tab via TabBar', () => {
		const { lastFrame, unmount } = renderConfig();
		const frame = lastFrame() ?? '';
		for (const label of ['Orchestrator', 'Planner', 'Auditor', 'Implementer', 'Reviewer', 'Ship', 'Global']) {
			expect(frame).toContain(label);
		}
		unmount();
	});

	// Asserted directly against the TabDef[] (not a rendered Ink frame): at
	// this screen's default 80-col mocked terminal width, 7 chips wrapped
	// together can word-wrap a "Label: value" chip's label and value onto
	// separate output lines, so substring-matching the rendered frame for
	// "Label: value" is unreliable. buildTabDefs is exported for exactly this.
	test('phase tab defs are confirmed with their current-or-default model; the Global tab has no value', () => {
		const defs = buildTabDefs({});
		expect(defs).toHaveLength(7);
		expect(defs[0]).toEqual({ label: 'Orchestrator', confirmed: true, value: DEFAULTS.orchestrator });
		expect(defs[5]).toEqual({ label: 'Ship', confirmed: true, value: DEFAULTS.ship });
		expect(defs[6]).toEqual({ label: 'Global' });
	});

	test('a chosen model overrides the default in its tab def', () => {
		const defs = buildTabDefs({ orchestrator: 'claude-sonnet-4-5-20250929' });
		expect(defs[0]).toEqual({ label: 'Orchestrator', confirmed: true, value: 'claude-sonnet-4-5-20250929' });
	});
});

describe('ConfigScreen — LLM tab shows model + effort + backend, Ship shows model + backend (AC2, AC7)', () => {
	test('the initial Orchestrator tab renders the model Select active, effort confirmed with its default, and backend confirmed with its default', () => {
		const { lastFrame, unmount } = renderConfig();
		const frame = lastFrame() ?? '';
		expect(frame).toContain('Model for orchestrator:');
		expect(frame).not.toContain('Effort for orchestrator:');
		expect(frame).not.toContain('Backend for orchestrator:');
		expect(frame).toContain(`✓ ${EFFORT_DEFAULTS.orchestrator}`);
		expect(frame).toContain(`✓ ${DEFAULTS.backend}`);
		unmount();
	});

	test('the Ship tab renders the model Select active and the backend Select confirmed -- no Effort block at all', async () => {
		const { lastFrame, stdin, unmount } = renderConfig();
		// Orchestrator -> ... -> Ship. TabBar's onChange computes the next
		// index from the current `activeIndex` PROP (not a functional
		// setState updater, unlike Select's internal idx); firing 5 Right
		// presses without letting React commit between them would collapse
		// into a single net step, so each write must be awaited individually.
		for (let i = 0; i < 5; i += 1) {
			stdin.write(RIGHT);
			await waitForFrame(lastFrame, () => true, { timeoutMs: 200 });
		}
		const frame = await waitForFrame(lastFrame, (f) => f.includes('Model for ship:'));
		expect(frame).toContain('Model for ship:');
		expect(frame).not.toContain('Effort');
		expect(frame).not.toContain('Backend for ship:'); // backend confirmed, not active
		expect(frame).toContain(`✓ ${DEFAULTS.backend}`);
		unmount();
	});
});

describe('ConfigScreen — Global tab parity, backend moved to per-phase tabs, no new fields (AC3)', () => {
	test('Global tab preserves merge-mode/plan-approval + notify recipient/from; no Backend section, no meta_loop/worker_isolation/orch_context_window', async () => {
		const { lastFrame, stdin, unmount } = renderConfig();
		stdin.write(LEFT); // wraps from Orchestrator (idx 0) to Global (last tab)
		// Only the merge-mode field (index 0) is interactive on landing; the
		// rest render their confirmed/default summary line, so assert on the
		// Section headings (always rendered) rather than each field's
		// question text (only rendered while that one field is active).
		const frame = await waitForFrame(lastFrame, (f) => f.includes('How should cam ship merge pull requests?'));
		expect(frame).toContain('Merge mode'); // interactive (field 0)
		expect(frame).toContain('Plan approval');
		expect(frame).toContain('Notify recipient');
		expect(frame).toContain('Notify sender');
		expect(frame).not.toContain('Backend'); // AC2: no global-only backend field remains
		expect(frame).not.toContain('meta_loop');
		expect(frame).not.toContain('worker_isolation');
		expect(frame).not.toContain('orch_context_window');
		unmount();
	});
});

describe('ConfigScreen — effort Select options (AC4)', () => {
	test('offers exactly low, medium, high, xhigh, max in that order', async () => {
		const { lastFrame, stdin, unmount } = renderConfig();
		stdin.write(ENTER); // confirm default model, advance focus to the effort field
		const frame = await waitForFrame(lastFrame, (f) => f.includes('Effort for orchestrator:'));
		const order = ['low', 'medium', 'high', 'xhigh', 'max'];
		let lastIndex = -1;
		for (const label of order) {
			const idx = frame.indexOf(label);
			expect(idx).toBeGreaterThan(lastIndex);
			lastIndex = idx;
		}
		unmount();
	});
});

describe('ConfigScreen — per-phase backend Select (US-003, CAM-349, AC1/AC2/AC5)', () => {
	test('LLM-phase tab: after model + effort are confirmed, the Backend Select becomes active and offers claude/codex', async () => {
		const { lastFrame, stdin, unmount } = renderConfig();
		stdin.write(ENTER); // confirm default model, advance to effort
		await waitForFrame(lastFrame, (f) => f.includes('Effort for orchestrator:'));
		stdin.write(ENTER); // confirm default effort, advance to backend
		const frame = await waitForFrame(lastFrame, (f) => f.includes('Backend for orchestrator:'));
		expect(frame).toContain('Backend for orchestrator:');
		expect(frame).toContain('claude');
		expect(frame).toContain('codex');
		unmount();
	});

	test('Ship tab: after model is confirmed, the Backend Select becomes active directly (no effort field)', async () => {
		const { lastFrame, stdin, unmount } = renderConfig();
		for (let i = 0; i < 5; i += 1) {
			stdin.write(RIGHT);
			await waitForFrame(lastFrame, () => true, { timeoutMs: 200 });
		}
		await waitForFrame(lastFrame, (f) => f.includes('Model for ship:'));
		stdin.write(ENTER); // confirm default model, advance to backend (fieldFocus 0 -> 1)
		const frame = await waitForFrame(lastFrame, (f) => f.includes('Backend for ship:'));
		expect(frame).toContain('Backend for ship:');
		unmount();
	});

	test('choosing codex for one phase persists only that phase in the onDone payload; every other phase still defaults to claude', async () => {
		let choices: ConfigChoices | undefined;
		const { lastFrame, stdin, unmount } = renderConfig((c) => {
			choices = c;
		});
		stdin.write(ENTER); // confirm default model, advance to effort
		await waitForFrame(lastFrame, (f) => f.includes('Effort for orchestrator:'));
		stdin.write(ENTER); // confirm default effort, advance to backend
		await waitForFrame(lastFrame, (f) => f.includes('Backend for orchestrator:'));
		stdin.write(DOWN); // claude (idx 0) -> codex (idx 1)
		await waitForFrame(lastFrame, (f) => f.includes('❯ codex'));
		stdin.write(ENTER); // commit codex, advance to Planner's model field
		await waitForFrame(lastFrame, (f) => f.includes('Model for planner:'));

		for (let i = 0; i < TOTAL_FIELD_COUNT - 3; i += 1) {
			stdin.write(TAB);
			await waitForFrame(lastFrame, () => true, { timeoutMs: 200 });
		}
		await waitForFrame(() => (choices ? 'done' : ''), (f) => f === 'done');
		expect(choices?.backend.orchestrator).toBe('codex');
		for (const phase of ALL_PHASES) {
			if (phase === 'orchestrator') continue;
			expect(choices?.backend[phase]).toBe(DEFAULTS.backend);
		}
		unmount();
	});
});

describe('ConfigScreen — focus/navigation chain (AC5)', () => {
	test('Up/Down navigates only the focused effort Select', async () => {
		const { lastFrame, stdin, unmount } = renderConfig();
		stdin.write(ENTER); // model -> effort
		await waitForFrame(lastFrame, (f) => f.includes('Effort for orchestrator:'));
		stdin.write(DOWN); // xhigh (idx 3) -> max (idx 4)
		const frame = await waitForFrame(lastFrame, (f) => f.includes('❯ max'));
		expect(frame).toContain('❯ max');
		expect(frame).not.toContain('❯ xhigh');
		unmount();
	});

	test('Tab advances focus without committing a value (the field stays untouched/default)', async () => {
		let choices: ConfigChoices | undefined;
		const { lastFrame, stdin, unmount } = renderConfig((c) => {
			choices = c;
		});
		stdin.write(DOWN); // highlight 'sonnet' on the model list, but do not commit
		await waitForFrame(lastFrame, (f) => f.includes('❯ sonnet'));
		stdin.write(TAB); // advance to effort WITHOUT confirming 'sonnet'
		const frame = await waitForFrame(lastFrame, (f) => f.includes('Effort for orchestrator:'));
		expect(frame).toContain(`✓ ${DEFAULTS.orchestrator}`); // model field fell back to its default

		for (let i = 0; i < TOTAL_FIELD_COUNT - 1; i += 1) {
			stdin.write(TAB);
			await waitForFrame(lastFrame, () => true, { timeoutMs: 200 });
		}
		await waitForFrame(() => (choices ? 'done' : ''), (f) => f === 'done');
		expect(choices?.models.orchestrator).toBe(DEFAULTS.orchestrator);
		unmount();
	});

	test('Enter commits the highlighted option and advances focus (model -> effort -> backend -> next tab)', async () => {
		const { lastFrame, stdin, unmount } = renderConfig();
		stdin.write(DOWN); // highlight 'sonnet'
		await waitForFrame(lastFrame, (f) => f.includes('❯ sonnet'));
		stdin.write(ENTER); // commit 'sonnet', advance to effort
		let frame = await waitForFrame(lastFrame, (f) => f.includes('Effort for orchestrator:'));
		expect(frame).toContain('✓ sonnet');

		stdin.write(ENTER); // commit default effort (xhigh), advance to backend
		frame = await waitForFrame(lastFrame, (f) => f.includes('Backend for orchestrator:'));
		expect(frame).toContain('✓ xhigh');

		stdin.write(ENTER); // commit default backend (claude), advance to Planner's model field
		frame = await waitForFrame(lastFrame, (f) => f.includes('Model for planner:'));
		expect(frame).toContain('Model for planner:');
		expect(frame).not.toContain('Model for orchestrator:'); // Orchestrator's Section is unmounted
		unmount();
	});

	test('Left/Right does NOT switch tabs while the notify-recipient text field is focused (suppressed navigation)', async () => {
		const { lastFrame, stdin, unmount } = renderConfig();
		stdin.write(LEFT); // Orchestrator -> Global (wrap); lands on field 0 (merge-mode)
		await waitForFrame(lastFrame, (f) => f.includes('How should cam ship merge pull requests?'));

		// Tab forward to notify-recipient (field 2): merge-mode -> plan-approval
		// -> notify-recipient. Each Tab awaited individually (see the
		// Ship-tab test's comment on why).
		for (let i = 0; i < 2; i += 1) {
			stdin.write(TAB);
			await waitForFrame(lastFrame, () => true, { timeoutMs: 200 });
		}
		await waitForFrame(lastFrame, (f) => f.includes('resend_recipient'));
		stdin.write('partial-typed-text'); // focus is on notify-recipient (field 2), start typing
		await waitForFrame(lastFrame, (f) => f.includes('partial-typed-text'));

		stdin.write(RIGHT); // suppressed: stays on Global's notify-recipient field
		stdin.write(LEFT); // suppressed too
		const frame = await waitForFrame(lastFrame, (f) => f.includes('partial-typed-text'), { timeoutMs: 200 });
		expect(frame).toContain('resend_recipient');
		expect(frame).toContain('partial-typed-text'); // typed draft untouched, cursor stayed in the field
		expect(frame).not.toContain('Model for orchestrator:'); // did NOT switch tabs
		unmount();
	});

	test('Left/Right does NOT switch tabs while the notify-sender text field is focused (suppressed navigation)', async () => {
		const { lastFrame, stdin, unmount } = renderConfig();
		stdin.write(LEFT); // Orchestrator -> Global (wrap); lands on field 0 (merge-mode)
		await waitForFrame(lastFrame, (f) => f.includes('How should cam ship merge pull requests?'));

		// Tab forward to notify-sender (field 3): merge-mode -> plan-approval ->
		// notify-recipient -> notify-sender. Each Tab awaited individually (see
		// the Ship-tab test's comment on why).
		for (let i = 0; i < 3; i += 1) {
			stdin.write(TAB);
			await waitForFrame(lastFrame, () => true, { timeoutMs: 200 });
		}
		await waitForFrame(lastFrame, (f) => f.includes('resend_from'));
		stdin.write('partial-typed-sender'); // focus is on notify-sender (field 3), start typing
		await waitForFrame(lastFrame, (f) => f.includes('partial-typed-sender'));

		stdin.write(RIGHT); // suppressed: stays on Global's notify-sender field
		stdin.write(LEFT); // suppressed too
		const frame = await waitForFrame(lastFrame, (f) => f.includes('partial-typed-sender'), { timeoutMs: 200 });
		expect(frame).toContain('resend_from');
		expect(frame).toContain('partial-typed-sender'); // typed draft untouched, cursor stayed in the field
		expect(frame).not.toContain('Model for orchestrator:'); // did NOT switch tabs
		unmount();
	});

	test('Left/Right still switches tabs when no TextInput is focused (a Select field is active)', async () => {
		const { lastFrame, stdin, unmount } = renderConfig();
		stdin.write(LEFT); // Orchestrator -> Global (wrap); lands on field 0 (merge-mode, a Select)
		await waitForFrame(lastFrame, (f) => f.includes('How should cam ship merge pull requests?'));

		stdin.write(RIGHT); // Global -> Orchestrator (wrap)
		const frame = await waitForFrame(lastFrame, (f) => f.includes('Model for orchestrator:'));
		expect(frame).toContain('Model for orchestrator:');
		expect(frame).not.toContain('How should cam ship merge pull requests?');
		unmount();
	});

	test('Left/Right does NOT switch tabs while the custom-model free-text entry is open', async () => {
		const { lastFrame, stdin, unmount } = renderConfig();
		// Orchestrator's model Select defaults to opus (idx 0); DOWN 8 times
		// reaches the last option, 'custom / enter id' (PHASE_MODEL_OPTIONS =
		// 8 aliases + the custom sentinel). Each press awaited individually
		// (see the Ship-tab test's comment on why un-awaited writes collapse).
		for (let i = 0; i < 8; i += 1) {
			stdin.write(DOWN);
			await waitForFrame(lastFrame, () => true, { timeoutMs: 200 });
		}
		await waitForFrame(lastFrame, (f) => f.includes('❯ custom / enter id'));
		stdin.write(ENTER); // opens the free-text CustomModelInput (customModel.phase = 'orchestrator')
		await waitForFrame(lastFrame, (f) => f.includes('Enter a model id:'));

		stdin.write(RIGHT); // suppressed: customModel.phase !== null
		const frame = await waitForFrame(lastFrame, (f) => f.includes('Enter a model id:'), { timeoutMs: 200 });
		expect(frame).toContain('Enter a model id:'); // stayed on the custom-entry field
		expect(frame).not.toContain('Model for planner:'); // did NOT switch tabs
		unmount();
	});
});

describe('ConfigScreen — computeNextFocus (AC5, pure helper)', () => {
	test('advances model -> effort within an LLM tab', () => {
		expect(computeNextFocus({ activeTab: 0, fieldFocus: 0 })).toEqual({ activeTab: 0, fieldFocus: 1 });
	});

	test('advances effort -> backend within an LLM tab', () => {
		expect(computeNextFocus({ activeTab: 0, fieldFocus: 1 })).toEqual({ activeTab: 0, fieldFocus: 2 });
	});

	test('advances from the last field (backend) of a tab to the first field of the next tab', () => {
		expect(computeNextFocus({ activeTab: 0, fieldFocus: 2 })).toEqual({ activeTab: 1, fieldFocus: 0 });
	});

	test('advances from Ship (model, backend) straight to Global (tab index 6)', () => {
		expect(computeNextFocus({ activeTab: 5, fieldFocus: 1 })).toEqual({ activeTab: 6, fieldFocus: 0 });
	});

	test('returns "done" past the last field (notify-from) of the last tab (Global)', () => {
		expect(computeNextFocus({ activeTab: 6, fieldFocus: 3 })).toBe('done');
	});
});

describe('ConfigScreen — onDone payload defaults (AC6)', () => {
	test('efforts defaults from EFFORT_DEFAULTS, models default, backend defaults to claude for every phase, and notify fields are "" when every field is skipped via Tab', async () => {
		let choices: ConfigChoices | undefined;
		const { lastFrame, stdin, unmount } = renderConfig((c) => {
			choices = c;
		});

		for (let i = 0; i < TOTAL_FIELD_COUNT; i += 1) {
			stdin.write(TAB);
			await waitForFrame(lastFrame, () => true, { timeoutMs: 200 });
		}
		const frame = await waitForFrame(lastFrame, (f) => f.includes('Configuration written'));
		expect(frame).toContain('Configuration written to scripts/cam/project.toml');
		expect(frame).toContain('✓');

		await waitForFrame(() => (choices ? 'done' : ''), (f) => f === 'done');
		expect(choices?.efforts).toEqual(EFFORT_DEFAULTS);
		for (const phase of ALL_PHASES) {
			expect(choices?.models[phase]).toBe(DEFAULTS[phase]);
			expect(choices?.backend[phase]).toBe(DEFAULTS.backend);
		}
		expect(choices?.mergeMode).toBe('immediate');
		expect(choices?.planApproval).toBe('auto');
		expect(choices?.resendRecipient).toBe('');
		expect(choices?.resendFrom).toBe('');
		unmount();
	});

	test('an explicitly chosen effort for one phase is preserved; untouched phases still default', async () => {
		let choices: ConfigChoices | undefined;
		const { lastFrame, stdin, unmount } = renderConfig((c) => {
			choices = c;
		});

		stdin.write(ENTER); // confirm default orchestrator model, advance to effort
		await waitForFrame(lastFrame, (f) => f.includes('Effort for orchestrator:'));
		stdin.write(DOWN); // xhigh -> max
		await waitForFrame(lastFrame, (f) => f.includes('❯ max'));
		stdin.write(ENTER); // commit 'max', advance to orchestrator's backend field
		await waitForFrame(lastFrame, (f) => f.includes('Backend for orchestrator:'));
		stdin.write(ENTER); // confirm default backend (claude), advance to Planner's model field
		await waitForFrame(lastFrame, (f) => f.includes('Model for planner:'));

		for (let i = 0; i < TOTAL_FIELD_COUNT - 3; i += 1) {
			stdin.write(TAB);
			await waitForFrame(lastFrame, () => true, { timeoutMs: 200 });
		}
		await waitForFrame(() => (choices ? 'done' : ''), (f) => f === 'done');
		expect(choices?.efforts?.orchestrator).toBe('max');
		expect(choices?.efforts?.planner).toBe(EFFORT_DEFAULTS.planner);
		unmount();
	});
});

describe('ConfigScreen — custom / enter id passthrough still works within a tab (regression, US-002)', () => {
	test('selecting the custom entry on the active model field reveals the free-text input, and the typed id is confirmed then advances to the effort field', async () => {
		let choices: ConfigChoices | undefined;
		const { lastFrame, stdin, unmount } = renderConfig((c) => {
			choices = c;
		});

		for (let i = 0; i < MODEL_OPTIONS.length; i += 1) stdin.write(DOWN); // down past all aliases to the custom row
		await waitForFrame(lastFrame, (f) => f.includes('❯ custom / enter id'));
		stdin.write(ENTER); // reveal the free-text input
		await waitForFrame(lastFrame, (f) => f.includes('Enter a model id'));

		const pinnedId = 'claude-sonnet-4-5-20250929';
		stdin.write(pinnedId);
		await waitForFrame(lastFrame, (f) => f.includes(pinnedId));
		stdin.write(ENTER); // submit

		const frame = await waitForFrame(lastFrame, (f) => f.includes('Effort for orchestrator:'));
		expect(frame).toContain(`✓ ${pinnedId}`);
		expect(frame).toContain('Effort for orchestrator:');

		for (let i = 0; i < TOTAL_FIELD_COUNT - 1; i += 1) {
			stdin.write(TAB);
			await waitForFrame(lastFrame, () => true, { timeoutMs: 200 });
		}
		await waitForFrame(() => (choices ? 'done' : ''), (f) => f === 'done');
		expect(choices?.models.orchestrator).toBe(pinnedId);
		unmount();
	});
});
