import { describe, expect, test } from "bun:test";
import type { IssueEntry } from "../../src/issues/types.ts";
import { isPlannable, isSpecifiedOpen } from "../../src/issues/plannable.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<IssueEntry> & { id: string }): IssueEntry {
	return {
		title: "Test issue",
		stage: "specified",
		status: "open",
		blockedBy: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// isPlannable: ADR-0051 acceptance-criteria gate
// ---------------------------------------------------------------------------

describe("isPlannable — acceptance-criteria gate (ADR-0051)", () => {
	test("rejects a specified/open entry with no spec key at all", () => {
		const entry = makeIssue({ id: "CAM-1" });
		expect(entry.spec).toBeUndefined();
		expect(isPlannable(entry, [entry])).toBe(false);
	});

	test("rejects a specified/open entry whose spec.acceptanceCriteria is an empty array", () => {
		const entry = makeIssue({
			id: "CAM-2",
			spec: { acceptanceCriteria: [], scope: "s", gotchas: [], domainTerms: [] },
		});
		expect(isPlannable(entry, [entry])).toBe(false);
	});

	test("accepts a specified/open/unblocked entry with non-empty acceptanceCriteria", () => {
		const entry = makeIssue({
			id: "CAM-3",
			spec: { acceptanceCriteria: ["do the thing"], scope: "s", gotchas: [], domainTerms: [] },
		});
		expect(isPlannable(entry, [entry])).toBe(true);
	});

	test("still rejects a blocked entry even with non-empty acceptanceCriteria", () => {
		const dep = makeIssue({ id: "CAM-4", stage: "idea" });
		const entry = makeIssue({
			id: "CAM-5",
			blockedBy: ["CAM-4"],
			spec: { acceptanceCriteria: ["x"], scope: "s", gotchas: [], domainTerms: [] },
		});
		expect(isPlannable(entry, [entry, dep])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isSpecifiedOpen: unaffected by the acceptance-criteria gate (US-001 note:
// rank.ts / gate.ts route through this layer only, retaining criteria-less
// entries for topological ranking and cycle detection).
// ---------------------------------------------------------------------------

describe("isSpecifiedOpen — universe core stays criteria-agnostic", () => {
	test("still true for a specified/open entry with no spec", () => {
		const entry = makeIssue({ id: "CAM-6" });
		expect(isSpecifiedOpen(entry)).toBe(true);
	});
});
