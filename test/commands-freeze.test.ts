// test/commands-freeze.test.ts
//
// US-002 (CAM-61 PRD): freeze COMMANDS' exact count and exact membership.
//
// COMMANDS is a runtime array (index.ts, `const COMMANDS = [...] as const`).
// Removing an entry from it does NOT break `bun run typecheck`: HELP_REGISTRY
// and the dispatch switch are typed against `Command = (typeof COMMANDS)[number]`,
// so a shorter COMMANDS array simply narrows the type to fewer members and
// everything still typechecks with fewer keys/cases. Without this test, a
// silent drop (or an unnoticed addition) of a subcommand from COMMANDS would
// pass typecheck and the relative HELP_REGISTRY/switch-parity checks in
// test/help-registry.test.ts (which compare COMMANDS against itself-derived
// sources, not against a hardcoded list) — this test is the only one that
// pins the actual, independently-verified list.

import { describe, expect, test } from 'bun:test';

import { COMMANDS } from '../index.ts';

// Verified against the live index.ts COMMANDS array (US-002). Update this
// list in the same commit as any COMMANDS addition/removal.
const FROZEN_COMMANDS = [
	'init',
	'setup',
	'config',
	'run',
	'plan',
	'spec',
	'issue',
	'next',
	'review',
	'ship',
	'tag',
	'dashboard',
	'status',
	'orch-budget',
	'stop',
	'drain',
	'resume',
	'decide',
	'claude',
	'sidecar',
	'orch-recycle-watch',
	'sidecar-liveness-watch',
	'retry-monitor',
	'journal',
	'patterns',
	'triage',
	'suggestions',
] as const;

describe('COMMANDS frozen count + membership (US-002)', () => {
	test('exact count (27 today)', () => {
		expect(COMMANDS.length).toBe(FROZEN_COMMANDS.length);
		expect(COMMANDS.length).toBe(27);
	});

	test('exact membership set (order-independent)', () => {
		expect([...COMMANDS].sort()).toEqual([...FROZEN_COMMANDS].sort());
	});
});
