# Positioning

This document is the canonical, repo-resident source for cam's category definition, unique-position thesis, and competitive landscape. It exists so the README differentiation section (CAM-331, out of scope for this document) has a single place to draw from, instead of citing machine-local research notes. Every fact below is restated self-contained: nothing here depends on a file outside this repository resolving correctly for a future reader.

## 1. Category definition

cam is a local software delivery runtime: a control plane for coding agents. It sits between an issue (or a PRD generated from one) and a merged, verified pull request, and it owns the outer loop that a human would otherwise run by hand: plan, implement, review, ship. The category is not "an AI coding agent" (cam does not write code itself; it dispatches Claude Code, and optionally other vendor CLIs, to do that) and it is not "an agent framework" (it does not expose a library for building arbitrary agents). It is the control plane that decides what a coding agent works on next, verifies what came back, and keeps a durable, git-resident record of the whole cycle.

The runtime is local-first by design: it runs on the operator's own machine, against the operator's own subscriptions, driving whichever CLI-authenticated coding agent CLIs are configured, rather than requiring a hosted backend or a per-seat SaaS account.

## 2. Unique-position thesis

### 2.1 Vendor-neutral subscription aggregation

cam's structural position is a vendor-neutral control plane that aggregates the capacity of the subscriptions the operator already has (Claude, and in the roadmap Gemini, GitHub Copilot, and others) and dispatches work across them with rate-limit-aware scheduling. No single vendor will build this: Anthropic has no incentive to route work to Codex, and OpenAI has no incentive to route work to Claude. Only a neutral third party can occupy the vendor-neutral aggregation position, because occupying it requires being indifferent to which vendor's meter is running. This is not a feature choice; it is a structural claim about who is capable of building it.

The runtime is argued in product terms, not implementation terms: a deterministic outer loop drives every cycle (plan, implement, review, ship) the same way every time, so a run is reproducible and auditable rather than being a single long, opaque agent session. Every claim of "done" is backed by falsifiable verification: typecheck, tests, and a project-defined quality spine that must exit zero before a story is considered complete, not a model's self-report. The loop is local-first: state lives in the operator's own git repository (PRD, handoff notes, event log), not in a vendor's hosted database, so the operator can inspect, resume, or roll back the record of any cycle from the working tree. Together this composes into a single, continuous cycle from issue to post-merge: an issue becomes a spec, a spec becomes a PRD of user stories, each story is implemented and independently reviewed, and the cycle only closes once the change has actually landed on the main branch.

### 2.2 The tokens-per-issue counter-thesis

The rest of the market (Gas Town, claude-flow, Orca, and the SPOQ research benchmark itself) is optimizing parallelism: running more agents at once against the same codebase. Under a single rate-limited subscription, parallelism is not the binding constraint. By Little's Law and the Theory of Constraints, throughput is bounded by tokens available in the rate-limit window divided by tokens spent per issue, independent of how many workers are running concurrently inside that same window. The SPOQ benchmark (arXiv 2606.03115) measured this directly: an unrestricted backend shows a 14.3x speedup from parallel agent execution, but that same workload collapses to a 1.4x speedup once the backend is constrained to 2 concurrent slots, which is the realistic shape of a single subscription's rate limit. Optimizing for more parallel agents on a rate-limited subscription is optimizing a non-constraint.

The only lever that actually moves throughput under this constraint is reducing tokens spent per issue, not running more agents at once. cam's roadmap names three concrete levers for that reduction, argued from established prior art rather than invented from scratch:

- Cumulative CEGIS-style review: each defect found during a review round becomes a persistent regression check that feeds every subsequent round, so the loop never rediscovers the same defect twice and review converges instead of oscillating, following the counterexample-guided inductive synthesis pattern (Solar-Lezama, 2006 and 2008).
- Incremental verification with early cutoff: after a story is fixed, only the invalidated cone of the review is re-run, not the full PRD's review from scratch, following the demand-driven rebuild taxonomy in Build Systems a la Carte (Mokhov and Peyton Jones, 2018), Adapton's incremental computation model (PLDI 2014), and the same principle rust-analyzer's Salsa engine applies to incremental compilation.
- Utility-based dispatch: what to work on next, and whether to dispatch at all, is decided by a utility function over tokens remaining in the window, the risk of the candidate story, and the expected number of review rounds, following the MAPE-K autonomic-computing loop (Kephart and Chess, 2003; Walsh et al., ICAC 2004) rather than a fixed priority queue.

No vendor whose business model is parallel-agent seat count has an incentive to make this argument; it directly reduces the number of agent-seconds sold. A vendor-neutral, subscription-aggregating control plane has no such conflict, which is the same structural argument as section 2.1 applied to the verification loop instead of the dispatch layer.

## 3. Competitive landscape

Claims below are restated from public sources and are dated where the underlying fact (GitHub star count, feature availability, pricing tier) is time-sensitive. This section is factual and traceable, not disparaging: every named tool below solves a real problem, and several are stronger than cam in the dimension each is built for.

### 3.1 Cockpits (parallel-agent desktop UIs)

- **Orca** (Stably AI, MIT licensed): an open-source agent development environment that runs a fleet of coding agent CLIs (Claude Code, Codex CLI, OpenCode, and others) in parallel worktrees, against the operator's own subscriptions, with mobile monitoring and steering. Over 12,500 GitHub stars as of 2026-07. Orca's differentiator is breadth of backend support and a polished multi-agent cockpit UI; it does not run a deterministic plan-implement-review-ship outer loop with falsifiable per-story verification gates the way cam does.
- **Conductor**: a macOS desktop app for running multiple Claude Code, Codex, and Cursor sessions in parallel, each in its own git worktree with setup scripts, diff review, and a pull request flow. It is a strong worktree-management and review UI, not an outer-loop runtime: it does not own PRD decomposition, per-story acceptance criteria, or a review-to-ship cycle.
- **Sculptor** (Imbue): an open-source, container-isolated parallel coding agent workspace, positioned as an orchestration and safety layer around an existing Claude Code subscription or API key rather than a model competitor. It runs agents in isolated containers instead of shared worktrees, catching issues like missing tests and hardcoded variables as agents work. Like Conductor and Orca, it is a cockpit around agent execution, not a spec-to-merge control plane.

### 3.2 Spec frameworks

- **BMAD-METHOD**: a spec-driven, two-phase framework. An agentic planning phase (Analyst, PM, and Architect agents collaborating on a PRD and architecture document) followed by context-engineered development, where a Scrum Master agent turns the plan into hyper-detailed story files a Dev agent implements. BMAD is strong on planning ceremony and role separation; it defines the spec-to-story pipeline but does not itself own a runtime that dispatches, verifies, and ships against a rate-limited subscription budget.

### 3.3 The ralph lineage

The "Ralph Wiggum technique," created by Geoffrey Huntley, is the direct ancestor of cam's own loop: a fresh-context agent re-run repeatedly against external memory (files, not conversation history) until a task is complete. `ralph-orchestrator` (mikeyobrien) formalizes this into a hat-based orchestration framework supporting multiple backends (Claude Code, Gemini CLI, Codex). cam's fresh-subagent-per-story implementer, driven by handoff.json as durable forward-context, is a direct descendant of this pattern; cam's addition is the deterministic outer loop with named quality gates and a structured review layer around it, rather than a single undifferentiated loop.

### 3.4 Gas Town and Beads

Gas Town (Steve Yegge) is an open-source orchestration system coordinating 20 to 30 Claude Code instances in parallel against the same codebase, described by its author as "Kubernetes for AI coding agents." Its state layer, Beads, is a git-backed issue tracker that acts as both data plane and control plane: agent identities, work assignments, and orchestration state all persist in git. Gas Town is the clearest existing example of optimizing for parallel agent count (section 2.2's counter-thesis target); its scale target is a team running dozens of concurrent agents, not a single-subscription solo operator budget-constrained by a 2-to-5-slot rate limit.

### 3.5 Direct runtime competitors

Pilot, Relay, Tenet, Forge, and Zeroshot are the closest direct competitors in outer-loop shape: each takes a ticket or issue through implementation, verification, and a pull request with minimal human intervention.

- **Pilot** has the most complete overlap with cam's end-to-end shape: ticket through execution, quality gates, pull request, CI, merge, and release. Its production configuration is API-oriented rather than subscription-first.
- **Relay** is the strongest at coordination: turning an issue or Linear ticket into a plan, decomposing it into a DAG of tasks, and tracking multiple agents through to merge.
- **Tenet** has the most durable architecture: specification through a DAG of workers with independent critics, SQLite-backed state, and recovery.
- **Forge** is philosophically closest to cam: a Claude Code plugin enforcing a mandatory specify-plan-execute-review-verify workflow.
- **Zeroshot** has the cleanest separation of execution and independent verification: issue-driven implementation, an independent verification pass, and auto-merge on a passing pull request.

### 3.6 Hosted agent platforms

Devin (Cognition Labs) is a proprietary, fully hosted "AI software engineer": given a task, it plans, reads external documentation, writes and debugs code, and can deploy the result, running on Cognition's infrastructure rather than the operator's own machine. OpenHands (formerly OpenDevin) is the open-source counterpart: a self-hostable agent platform with an integrated editor, terminal, browser, and closed loop from a natural-language requirement to a verified result. Cursor and Codex cloud both offer a hosted "background agent" mode, dispatching a coding agent to a remote sandbox to work a task asynchronously and return a diff for review, layered on top of their respective editor or CLI products. All four are hosted-first: the operator's subscription pays for hosted agent-seconds, not for a runtime that orchestrates the operator's own local CLI sessions, which is the opposite of cam's local-first, bring-your-own-subscription position from section 1.

### 3.7 Industrial benchmark

Spotify Honk is not a product available for adoption; it is the internal codename for Spotify's background coding agent, integrated into the company's Fleet Management system. Spotify reports the platform has produced over 1,500 pull requests generated by agents and merged to production, with an estimated 60 to 90 percent time savings on certain migrations compared to manual work. Honk uses independent, deterministic verifiers for format, build, and tests, feeding only relevant failures back to the agent, followed by an LLM judge over the original prompt and the diff. Honk is cam's strongest evidence that the discipline of deterministic verification, independent verifiers, and structured feedback back to the agent (rather than trusting a single long agent session) is what makes background coding agents reliable at scale; it is the industrial precedent cam is translating from a corporate Fleet Management team down to a single local operator.
