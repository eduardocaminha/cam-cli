// src/supervisor/drain-preconditions.ts
//
// Pure fail-closed precondition evaluator for the inter-cycle auto-drain.
//
// Before the drain runner starts a new autonomous cycle, it must confirm:
//   1. The worker container is active (worker_isolation === 'container' AND
//      the injected preflight result is ready === true). Host mode never drains.
//   2. plan_approval === 'auto'. A human-gated plan approval loop must not
//      be bypassed by unattended cycle-chaining.
//
// Design invariants:
//   - Zero I/O. All inputs are injected by the caller. No filesystem, docker,
//     network, or process calls occur inside this module.
//   - Fail-closed (CAM-96): any doubt refuses. Unknown/missing config values
//     produce ok:false.
//   - Container-active check (CAM-111): both isolation mode AND preflight
//     readiness must pass. Either failing alone is enough to refuse.
//   - Resend config is NOT a precondition (operator decision 2026-06-30).
//
// noUncheckedIndexedAccess: no array indexing in this file.

import type { PreflightResult } from './preflight-container.ts';
import type { PlanApproval, WorkerIsolation } from '../config/models.ts';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Discriminated result returned by `evaluateDrainPreconditions`.
 *
 *   - `{ ok: true }` -- all preconditions satisfied; the drain may proceed.
 *   - `{ ok: false; reason: 'container-not-active' }` -- worker_isolation is
 *     not 'container', or the injected container preflight is not ready. Host
 *     mode never drains (fail-closed).
 *   - `{ ok: false; reason: 'plan-approval-not-auto' }` -- plan_approval is
 *     not 'auto'. A human-gated loop must not chain autonomously.
 */
export type DrainPreconditionResult =
	| { ok: true }
	| { ok: false; reason: 'container-not-active' | 'plan-approval-not-auto' };

// ---------------------------------------------------------------------------
// Inputs type
// ---------------------------------------------------------------------------

/**
 * All inputs required by `evaluateDrainPreconditions`. Injected by the caller;
 * this module performs no I/O to resolve them.
 */
export interface DrainPreconditionInputs {
	/**
	 * The worker isolation mode read from project config.
	 * Must be `'container'` for the drain to be allowed.
	 */
	workerIsolation: WorkerIsolation;

	/**
	 * The result of `preflightWorkerContainer` (or an equivalent injectable
	 * fake). Must be `{ ready: true }` for the drain to be allowed.
	 */
	containerPreflight: PreflightResult;

	/**
	 * The plan approval mode read from project config.
	 * Must be `'auto'` for the drain to be allowed.
	 */
	planApproval: PlanApproval;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Pure fail-closed precondition gate for the inter-cycle auto-drain.
 *
 * Checks are ordered: container-active first, then plan-approval. The first
 * failing check determines the returned reason; subsequent checks are not
 * evaluated once a failure is found.
 *
 * This function is a pure predicate: given the same inputs it always returns
 * the same result, with no observable side-effects and no I/O.
 *
 * @param inputs  Injected precondition inputs (isolation, preflight, approval).
 * @returns       `{ ok: true }` when all preconditions pass, or
 *                `{ ok: false; reason }` naming the first failing precondition.
 */
export function evaluateDrainPreconditions(
	inputs: DrainPreconditionInputs,
): DrainPreconditionResult {
	const { workerIsolation, containerPreflight, planApproval } = inputs;

	// --- Check 1: container active (CAM-111) ---
	// Both conditions must hold: isolation mode is 'container' AND preflight
	// reports ready. A host-mode project, a missing image, an unreachable
	// daemon, or a stale image all map to 'container-not-active' (fail-closed).
	if (workerIsolation !== 'container' || !containerPreflight.ready) {
		return { ok: false, reason: 'container-not-active' };
	}

	// --- Check 2: plan approval is auto ---
	// The drain must not chain a new cycle while the project requires a human
	// to approve the plan. 'operator' approval mode = human gate = no auto-drain.
	if (planApproval !== 'auto') {
		return { ok: false, reason: 'plan-approval-not-auto' };
	}

	return { ok: true };
}
