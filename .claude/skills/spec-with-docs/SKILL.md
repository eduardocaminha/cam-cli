---
name: spec-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.
disable-model-invocation: true
---

Run a `/grilling` session, using the `/domain-modeling` skill.

When recommending approaches or designs during this session: rank by engineering merit (quality, launch-readiness), never by execution cost. Effort, "v1", "future", or complexity are not reasons to downgrade a recommendation. If cost is high, note it as a separate factor after the recommendation. This is quality-within-scope, not gold-plating: Simplicity (scope stays minimal) remains the scope limiter.

When the plan being specced will produce a PRD, the acceptance criteria you hand over are only as good as the shell oracles under them. Before delivering the spec, apply the curated oracle authoring rules in `scripts/cam/patterns.md` (grep for "CURATED BLOCK: oracle authoring rules"). The four that matter most here:

1. Label the species of each oracle. Change-detection oracles get swept RED against main; invariance pins are green by construction with the comparand derived from main at check time.
2. Never freeze a comparand into the oracle text. If a lint flags one and the value provably does not rot, restate the check in a literal-free form rather than asking for an exemption.
3. Run every oracle against the pre-change tree before delivering, to catch pairs of acceptance criteria that are jointly unsatisfiable.
4. For prose deliverables (ADR, README, positioning), token-presence grep verifies nothing about fidelity. Write an oracle that fails when a claim quoted from the spec is replaced by plausible but invented prose, and sweep it red against a fabricated-evidence copy first.

Deliver the FORM of the oracle, not the claim: paste the literal check text, already swept for falsifiability. Seven consecutive cycles in this project had the spec, not the planner, as the source of the defect, and every one of them was a claim delivered without its form.

Decompose by verification mode or by risk isolation, never by story count.
