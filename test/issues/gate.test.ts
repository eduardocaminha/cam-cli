import { test, expect, describe } from "bun:test";
import { runGraphGate } from "../../src/issues/gate.ts";
import type { IssueEntry } from "../../src/issues/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(
	id: string,
	opts: {
		stage?: IssueEntry["stage"];
		status?: IssueEntry["status"];
		blockedBy?: string[];
		wsjf?: { value: number; timeCriticality: number; riskReduction: number; jobSize: number };
	} = {},
): IssueEntry {
	return {
		id,
		title: id,
		stage: opts.stage ?? "specified",
		status: opts.status ?? "open",
		blockedBy: opts.blockedBy ?? [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		wsjf: opts.wsjf,
	};
}

// Default WSJF that is always valid.
const W = { value: 3, timeCriticality: 1, riskReduction: 1, jobSize: 1 };

// ---------------------------------------------------------------------------
// Clean / acyclic graph
// ---------------------------------------------------------------------------

describe("clean acyclic graph", () => {
	test("returns ok: true with no warnings for a clean DAG", () => {
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { wsjf: W }),
			makeIssue("CAM-2", { blockedBy: ["CAM-1"], wsjf: W }),
		];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.warnings).toHaveLength(0);
		}
	});

	test("empty backlog returns ok: true", () => {
		const result = runGraphGate([]);
		expect(result.ok).toBe(true);
	});

	test("backlog with only non-universe issues returns ok: true", () => {
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { stage: "idea" }),
			makeIssue("CAM-2", { stage: "shipped" }),
		];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Cycle detection -- AC#1
// ---------------------------------------------------------------------------

describe("cycle detection (AC#1)", () => {
	test("2-node mutual cycle: hard fails with kind 'cycle'", () => {
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { blockedBy: ["CAM-2"], wsjf: W }),
			makeIssue("CAM-2", { blockedBy: ["CAM-1"], wsjf: W }),
		];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("cycle");
			expect(result.errors).toHaveLength(1);
		}
	});

	test("2-node cycle: error names both ids (cycle path present)", () => {
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { blockedBy: ["CAM-2"], wsjf: W }),
			makeIssue("CAM-2", { blockedBy: ["CAM-1"], wsjf: W }),
		];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			// Both ids must appear in the cycle path error.
			expect(result.errors[0]).toContain("CAM-1");
			expect(result.errors[0]).toContain("CAM-2");
			// The path uses ' -> ' arrows (e.g. "CAM-1 -> CAM-2 -> CAM-1").
			expect(result.errors[0]).toContain(" -> ");
		}
	});

	test("2-node cycle: cycle path closes back to start (format: A -> B -> A)", () => {
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { blockedBy: ["CAM-2"], wsjf: W }),
			makeIssue("CAM-2", { blockedBy: ["CAM-1"], wsjf: W }),
		];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			// Regex checks the path ends with the same token it starts with.
			expect(result.errors[0]).toMatch(/CAM-\d+ -> CAM-\d+ -> CAM-\d+/);
		}
	});

	test("3-node cycle: hard fails and names all three ids", () => {
		// CAM-1 <- CAM-3, CAM-2 <- CAM-1, CAM-3 <- CAM-2 (chain: 1->2->3->1)
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { blockedBy: ["CAM-3"], wsjf: W }),
			makeIssue("CAM-2", { blockedBy: ["CAM-1"], wsjf: W }),
			makeIssue("CAM-3", { blockedBy: ["CAM-2"], wsjf: W }),
		];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("cycle");
			expect(result.errors[0]).toContain("CAM-1");
			expect(result.errors[0]).toContain("CAM-2");
			expect(result.errors[0]).toContain("CAM-3");
		}
	});

	test("partial cycle: free issue exists but cycle causes overall hard fail", () => {
		// CAM-1 is free; CAM-2 <-> CAM-3 form a cycle.
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { wsjf: W }),
			makeIssue("CAM-2", { blockedBy: ["CAM-3"], wsjf: W }),
			makeIssue("CAM-3", { blockedBy: ["CAM-2"], wsjf: W }),
		];
		const result = runGraphGate(backlog);
		// Even though CAM-1 can rank, the cycle makes the gate fail.
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("cycle");
			expect(result.errors[0]).toContain("CAM-2");
			expect(result.errors[0]).toContain("CAM-3");
		}
	});

	test("cycle gate returns no rank (pure check -- gate itself never writes)", () => {
		// The gate is a pure check; it returns ok:false so the caller won't write rank.
		// Assert that the return value has no 'ranked' field (not a RankResult).
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { blockedBy: ["CAM-2"], wsjf: W }),
			makeIssue("CAM-2", { blockedBy: ["CAM-1"], wsjf: W }),
		];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(false);
		expect("ranked" in result).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Referential integrity -- AC#2
// ---------------------------------------------------------------------------

describe("referential integrity (AC#2)", () => {
	test("missing-id dep: hard fails with kind 'integrity', names offending edge", () => {
		const backlog: IssueEntry[] = [makeIssue("CAM-1", { blockedBy: ["CAM-GHOST"], wsjf: W })];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("integrity");
			expect(result.errors).toHaveLength(1);
			// Both the issue id and the missing dep must appear in the error.
			expect(result.errors[0]).toContain("CAM-1");
			expect(result.errors[0]).toContain("CAM-GHOST");
		}
	});

	test("missing-id: no rank is computed (ok: false)", () => {
		const backlog: IssueEntry[] = [makeIssue("CAM-1", { blockedBy: ["MISSING"], wsjf: W })];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(false);
	});

	test("self-reference: hard fails with kind 'integrity', names the offending id", () => {
		const backlog: IssueEntry[] = [makeIssue("CAM-1", { blockedBy: ["CAM-1"], wsjf: W })];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("integrity");
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]).toContain("CAM-1");
			expect(result.errors[0]).toContain("Self-reference");
		}
	});

	test("self-reference: no rank is computed (ok: false)", () => {
		const backlog: IssueEntry[] = [makeIssue("CAM-1", { blockedBy: ["CAM-1"], wsjf: W })];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(false);
	});

	test("both missing-id and self-ref in the same entry: both errors flagged", () => {
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { blockedBy: ["CAM-MISSING", "CAM-1"], wsjf: W }),
		];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("integrity");
			expect(result.errors).toHaveLength(2);
		}
	});

	test("integrity violation takes precedence over cycle (checked first)", () => {
		// CAM-1 and CAM-2 form a cycle, but CAM-1 also references a missing id.
		// Integrity check runs before cycle detection -> kind must be 'integrity'.
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { blockedBy: ["CAM-2", "GHOST"], wsjf: W }),
			makeIssue("CAM-2", { blockedBy: ["CAM-1"], wsjf: W }),
		];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("integrity");
		}
	});
});

// ---------------------------------------------------------------------------
// Cross-stage blockers -- AC#3
// ---------------------------------------------------------------------------

describe("cross-stage blockers (AC#3)", () => {
	test("specified issue blocked by idea issue: ok:true, warning emitted", () => {
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { stage: "idea" }),
			makeIssue("CAM-2", { stage: "specified", status: "open", blockedBy: ["CAM-1"], wsjf: W }),
		];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]).toContain("CAM-1");
			expect(result.warnings[0]).toContain("CAM-2");
		}
	});

	test("specified issue blocked by abandoned issue: ok:true, warning emitted", () => {
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { stage: "specified", status: "abandoned" }),
			makeIssue("CAM-2", { stage: "specified", status: "open", blockedBy: ["CAM-1"], wsjf: W }),
		];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]).toContain("CAM-1");
			expect(result.warnings[0]).toContain("CAM-2");
		}
	});

	test("specified issue blocked by planned issue: ok:true, warning emitted", () => {
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { stage: "planned" }),
			makeIssue("CAM-2", { stage: "specified", status: "open", blockedBy: ["CAM-1"], wsjf: W }),
		];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.warnings).toHaveLength(1);
		}
	});

	test("specified issue blocked by shipped issue: ok:true, NO warning (shipped = silently satisfied)", () => {
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { stage: "shipped" }),
			makeIssue("CAM-2", { stage: "specified", status: "open", blockedBy: ["CAM-1"], wsjf: W }),
		];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.warnings).toHaveLength(0);
		}
	});

	test("cross-stage blocker: intra-set rank is unaffected (gate passes ok:true)", () => {
		// CAM-2 blocked by idea CAM-1 (cross-stage): gate passes; rank.ts treats it satisfied.
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { stage: "idea" }),
			makeIssue("CAM-2", { stage: "specified", status: "open", blockedBy: ["CAM-1"], wsjf: W }),
			makeIssue("CAM-3", { stage: "specified", status: "open", wsjf: W }),
		];
		const result = runGraphGate(backlog);
		// Gate must pass (ok: true) -- the caller (US-004) will then rank CAM-2 and CAM-3.
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.warnings).toHaveLength(1);
		}
	});

	test("multiple cross-stage blockers: each emits a separate warning", () => {
		const backlog: IssueEntry[] = [
			makeIssue("CAM-1", { stage: "idea" }),
			makeIssue("CAM-2", { stage: "idea" }),
			makeIssue("CAM-3", { stage: "specified", status: "open", blockedBy: ["CAM-1", "CAM-2"], wsjf: W }),
		];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.warnings).toHaveLength(2);
		}
	});

	test("cross-stage warning included in cycle hard-fail result", () => {
		// CAM-1 (universe) is blocked by idea CAM-0 (cross-stage warn).
		// CAM-1 <-> CAM-2 form a cycle (hard fail).
		// Both the warning and the cycle error should appear.
		const backlog: IssueEntry[] = [
			makeIssue("CAM-0", { stage: "idea" }),
			makeIssue("CAM-1", { blockedBy: ["CAM-2", "CAM-0"], wsjf: W }),
			makeIssue("CAM-2", { blockedBy: ["CAM-1"], wsjf: W }),
		];
		const result = runGraphGate(backlog);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe("cycle");
			// Cross-stage warning is still collected before cycle detection.
			expect(result.warnings).toHaveLength(1);
			expect(result.warnings[0]).toContain("CAM-0");
		}
	});
});
