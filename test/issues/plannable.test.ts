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
// isPlannable: executable-spec boundary
// ---------------------------------------------------------------------------

describe("isPlannable — executable spec", () => {
	test("rejects a specified/open entry with no spec key at all", () => {
		const entry = makeIssue({ id: "CAM-1" });
		expect(entry.spec).toBeUndefined();
		expect(isPlannable(entry, [entry])).toBe(false);
	});

	test("rejects a specified/open entry whose spec.verify is empty", () => {
		const entry = makeIssue({
			id: "CAM-2",
			spec: { verify: [], scope: "s" },
		});
		expect(isPlannable(entry, [entry])).toBe(false);
	});

	test("accepts a specified/open/unblocked entry with direct verification", () => {
		const entry = makeIssue({
			id: "CAM-3",
			spec: { verify: ["bun test"], scope: "s" },
		});
		expect(isPlannable(entry, [entry])).toBe(true);
	});

	test("accepts a legacy acceptanceCriteria issue while the backlog drains", () => {
		const entry = makeIssue({
			id: "CAM-legacy",
			spec: { acceptanceCriteria: ["do the thing"], scope: "s" },
		});
		expect(isPlannable(entry, [entry])).toBe(true);
	});

	test("still rejects a blocked entry even with non-empty acceptanceCriteria", () => {
		const dep = makeIssue({ id: "CAM-4", stage: "idea" });
		const entry = makeIssue({
			id: "CAM-5",
			blockedBy: ["CAM-4"],
			spec: { verify: ["bun test"], scope: "s" },
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
