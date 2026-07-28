# ADR 0051: An issue is not plannable unless it carries oracle forms

## Context

The plannable predicate checked only stage, status and blocked-by, never the specification body. The derived and fast-track filing paths promote an issue directly to stage specified while omitting the spec key entirely, so an issue could satisfy the gate while carrying zero acceptance criteria. Measured on main on 2026-07-28, three of the four plannable issues (CAM-432, CAM-441, CAM-447) carried zero acceptance criteria; only the one issue that had been through a real spec interview carried any. The planner therefore received prose and invented every check itself. This is the documented cause of eight consecutive cycles whose defect was born in the specification rather than in the planner, and the structured channel intended to carry oracle forms was unused on every derived issue.

## Decision

The plannable gate additionally requires a non-empty set of acceptance criteria, and the filing path gains a channel to supply those criteria at filing time so that a derived or fast-tracked issue can be filed already carrying swept oracle forms. The gate applies uniformly to both the derived and the operator provenance; a provenance-conditional gate would leave the same hole open under a different flag. Three alternatives were considered: gating in the predicate alone, which is enforceable but blocks autonomous planning of derived issues; filing derived issues at stage idea, which forces a full interview even for mechanical work; and requiring the forms at filing time alone, which preserves autonomy but depends entirely on filer discipline. The first and third were adopted together, so that authoring happens where the evidence is freshest while a gate keeps it from silently regressing.

## Consequences

Issues already filed at stage specified without acceptance criteria stop being plannable until each receives a spec pass; on adoption that was CAM-432, CAM-441 and CAM-447. This blast radius is intended and was confirmed with the operator, and no grandfather clause is provided, because an exemption would preserve exactly the hole the gate exists to close. Filing a derived issue becomes more expensive at the moment of filing, in exchange for removing the downstream cost of a planner inventing unsatisfiable or vacuous checks. Any tooling that reports the backlog must read the specification from the issue record rather than from a projection that strips it.
