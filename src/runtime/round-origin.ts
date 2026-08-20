import type { RunEvent } from './run-store.ts';

/**
 * Every event kind that opens a new pass through the executor -- i.e. a
 * transition into `working` (GSHIP-659). `run.started` fires both for a run's
 * own launch and for every resume; `run.review-fix-requested` and
 * `run.full-verify-fix-requested` fire only for the runtime's own automatic
 * fix rounds.
 */
const ROUND_START_KINDS: ReadonlySet<string> = new Set([
	'run.started',
	'run.review-fix-requested',
	'run.full-verify-fix-requested',
]);

/**
 * Counts of a run's correction rounds, grouped by where each one came from.
 * `indeterminate` is a round the recorded history admits no pattern for --
 * never a guess.
 */
export interface RunRoundOrigins {
	executor: number;
	decision: number;
	indeterminate: number;
}

/**
 * Derives, from a run's own decision-class history (GSHIP-627's
 * `listRunDecisionEvents`, read in order), where each correction round came
 * from -- the executor's own automatic fix, or the consequence of an operator
 * decision (GSHIP-659). No new capture: every event this reads already exists
 * because the runtime records its transitions as decisions by construction.
 *
 * The run's own first entry into `working` is the launch, not a correction,
 * so it is never counted. `run.review-fix-requested` and
 * `run.full-verify-fix-requested` are raised by the runtime itself, mid-run,
 * with no operator turn possible in between -- always `executor`. Every other
 * round starts at `run.started`, which fires both for that first launch and
 * for every later resume; a resume is `decision` only when the event
 * immediately before it is `run.operator-guidance` -- exactly what
 * `resumeRun` emits, synchronously, right before it. Any other resume (e.g.
 * recovering an interrupted run with no guidance) matches neither rule, so it
 * is reported `indeterminate` rather than attributed by supposition.
 */
export function selectRunRoundOrigins(events: readonly RunEvent[]): RunRoundOrigins {
	const origins: RunRoundOrigins = { executor: 0, decision: 0, indeterminate: 0 };
	let seenFirstRound = false;
	let previousKind: string | null = null;
	for (const event of events) {
		if (ROUND_START_KINDS.has(event.kind)) {
			if (!seenFirstRound) {
				seenFirstRound = true;
			} else if (event.kind === 'run.started') {
				if (previousKind === 'run.operator-guidance') origins.decision += 1;
				else origins.indeterminate += 1;
			} else {
				origins.executor += 1;
			}
		}
		previousKind = event.kind;
	}
	return origins;
}
