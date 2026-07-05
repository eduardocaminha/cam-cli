// test/supervisor/drain-preconditions.test.ts
//
// Unit tests for the pure drain precondition evaluator (US-003).
//
// Coverage:
//   AC1  pure function -- returns discriminated result from injected inputs,
//        performs no I/O.
//   AC2  refuses (container-not-active) when workerIsolation !== 'container'
//        OR the injected preflight is not ready.
//   AC3  refuses (plan-approval-not-auto) when planApproval !== 'auto'.
//   AC4  returns ok:true only when container is active/ready AND
//        planApproval === 'auto'. Resend config is NOT consulted.

import { describe, expect, test } from 'bun:test';
import {
	evaluateDrainPreconditions,
	type DrainPreconditionInputs,
	type DrainPreconditionResult,
} from '../../src/supervisor/drain-preconditions.ts';
import type { PreflightResult } from '../../src/supervisor/preflight-container.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const READY: PreflightResult = { ready: true };
const NOT_READY_DAEMON: PreflightResult = { ready: false, reason: 'daemon-unreachable' };
const NOT_READY_IMAGE: PreflightResult = { ready: false, reason: 'image-missing' };
const NOT_READY_STALE: PreflightResult = { ready: false, reason: 'image-stale' };

function ok(): DrainPreconditionResult {
	return { ok: true };
}

function notActive(): DrainPreconditionResult {
	return { ok: false, reason: 'container-not-active' };
}

function notAuto(): DrainPreconditionResult {
	return { ok: false, reason: 'plan-approval-not-auto' };
}

// ---------------------------------------------------------------------------
// AC4: happy path -- container active + auto approval
// ---------------------------------------------------------------------------

describe('evaluateDrainPreconditions -- happy path', () => {
	test('returns ok:true when container is ready and planApproval is auto', () => {
		const inputs: DrainPreconditionInputs = {
			workerIsolation: 'container',
			containerPreflight: READY,
			planApproval: 'auto',
		};
		expect(evaluateDrainPreconditions(inputs)).toEqual(ok());
	});
});

// ---------------------------------------------------------------------------
// AC2: container-not-active cases
// ---------------------------------------------------------------------------

describe('evaluateDrainPreconditions -- container-not-active', () => {
	test('refuses when workerIsolation is "host" (even if preflight is ready)', () => {
		const inputs: DrainPreconditionInputs = {
			workerIsolation: 'host',
			containerPreflight: READY,
			planApproval: 'auto',
		};
		expect(evaluateDrainPreconditions(inputs)).toEqual(notActive());
	});

	test('refuses when workerIsolation is "host" and preflight is not ready', () => {
		const inputs: DrainPreconditionInputs = {
			workerIsolation: 'host',
			containerPreflight: NOT_READY_DAEMON,
			planApproval: 'auto',
		};
		expect(evaluateDrainPreconditions(inputs)).toEqual(notActive());
	});

	test('refuses when workerIsolation is "container" but daemon is unreachable', () => {
		const inputs: DrainPreconditionInputs = {
			workerIsolation: 'container',
			containerPreflight: NOT_READY_DAEMON,
			planApproval: 'auto',
		};
		expect(evaluateDrainPreconditions(inputs)).toEqual(notActive());
	});

	test('refuses when workerIsolation is "container" but image is missing', () => {
		const inputs: DrainPreconditionInputs = {
			workerIsolation: 'container',
			containerPreflight: NOT_READY_IMAGE,
			planApproval: 'auto',
		};
		expect(evaluateDrainPreconditions(inputs)).toEqual(notActive());
	});

	test('refuses when workerIsolation is "container" but image is stale', () => {
		const inputs: DrainPreconditionInputs = {
			workerIsolation: 'container',
			containerPreflight: NOT_READY_STALE,
			planApproval: 'auto',
		};
		expect(evaluateDrainPreconditions(inputs)).toEqual(notActive());
	});
});

// ---------------------------------------------------------------------------
// AC3: plan-approval-not-auto cases
// ---------------------------------------------------------------------------

describe('evaluateDrainPreconditions -- plan-approval-not-auto', () => {
	test('refuses when planApproval is "operator" (container is active)', () => {
		const inputs: DrainPreconditionInputs = {
			workerIsolation: 'container',
			containerPreflight: READY,
			planApproval: 'operator',
		};
		expect(evaluateDrainPreconditions(inputs)).toEqual(notAuto());
	});
});

// ---------------------------------------------------------------------------
// AC2 takes priority over AC3 (check ordering: container first)
// ---------------------------------------------------------------------------

describe('evaluateDrainPreconditions -- check ordering', () => {
	test('container-not-active is returned when BOTH container and approval fail', () => {
		// Both checks fail; the first (container-not-active) must be the reason.
		const inputs: DrainPreconditionInputs = {
			workerIsolation: 'host',
			containerPreflight: NOT_READY_DAEMON,
			planApproval: 'operator',
		};
		const result = evaluateDrainPreconditions(inputs);
		expect(result).toEqual(notActive());
		// Sanity: confirm it did NOT return the plan-approval reason.
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe('container-not-active');
		}
	});

	test('plan-approval-not-auto is returned only when container passes but approval fails', () => {
		const inputs: DrainPreconditionInputs = {
			workerIsolation: 'container',
			containerPreflight: READY,
			planApproval: 'operator',
		};
		const result = evaluateDrainPreconditions(inputs);
		expect(result).toEqual(notAuto());
		if (!result.ok) {
			expect(result.reason).toBe('plan-approval-not-auto');
		}
	});
});

// ---------------------------------------------------------------------------
// AC4: Resend config is NOT consulted (purity check)
// ---------------------------------------------------------------------------

describe('evaluateDrainPreconditions -- Resend not consulted', () => {
	// The function must not reach for any Resend/environment state.
	// Since the function signature only accepts the three injected inputs,
	// this is structurally enforced. This test documents the invariant.
	test('same inputs always produce the same result (pure function)', () => {
		const inputs: DrainPreconditionInputs = {
			workerIsolation: 'container',
			containerPreflight: READY,
			planApproval: 'auto',
		};
		const r1 = evaluateDrainPreconditions(inputs);
		const r2 = evaluateDrainPreconditions(inputs);
		expect(r1).toEqual(r2);
		expect(r1).toEqual(ok());
	});

	test('same inputs always produce the same failure (pure function)', () => {
		const inputs: DrainPreconditionInputs = {
			workerIsolation: 'host',
			containerPreflight: NOT_READY_IMAGE,
			planApproval: 'operator',
		};
		const r1 = evaluateDrainPreconditions(inputs);
		const r2 = evaluateDrainPreconditions(inputs);
		expect(r1).toEqual(r2);
		expect(r1).toEqual(notActive());
	});
});
