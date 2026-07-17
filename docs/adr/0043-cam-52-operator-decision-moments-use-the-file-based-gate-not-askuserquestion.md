# ADR 0043: CAM-52 operator-decision moments use the file-based gate, not AskUserQuestion

## Context

CAM-52 Story 5 as filed asked for a canonical use of the AskUserQuestion tool at three moments (scope approval, ambiguity/blocker, review product-decision triage). But cam already shipped a file-based operator-decision gate (cam-gate.schema.json + the cam decide return channel) under ADR-0041, and the AskUserQuestion tool is explicitly disallowed for every cam subagent (planner, reviewer, implementer, auditor, orchestrator). Introducing AskUserQuestion would fork the operator-decision mechanism and contradict a shipped architectural decision.

## Decision

Reject the AskUserQuestion framing of Story 5. Wire the three operator-decision moments to the EXISTING file-based gate primitive (cam decide / cam-gate.schema.json). AskUserQuestion stays disallowed for all subagents. All CAM-52 output templates target the deterministic artifact layer (report JSON, composePrBody sections, planner schema), not markdown command prose, consistent with the CAM-197 direction.

## Consequences

One operator-decision mechanism is preserved (no fork); the issue's literal Story 5 ask is not implemented as written; new operator-decision moments must define a gate schema entry and resume via cam decide; contributors reading the issue must consult this ADR to understand why AskUserQuestion was not used.
