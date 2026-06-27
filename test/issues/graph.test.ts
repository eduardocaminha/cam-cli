import { expect, test, describe } from "bun:test";
import {
	isBlocked,
	deriveBlocks,
	checkReferentialIntegrity,
} from "../../src/issues/graph.ts";
import type { IssueEntry } from "../../src/issues/types.ts";

function makeEntry(
	id: string,
	stage: IssueEntry["stage"],
	blockedBy: string[] = [],
): IssueEntry {
	return {
		id,
		title: `Issue ${id}`,
		stage,
		status: "open",
		blockedBy,
		createdAt: "2026-01-01T00:00:00Z",
	};
}

describe("isBlocked", () => {
	test("returns false when blockedBy is empty", () => {
		const issue = makeEntry("A", "idea");
		expect(isBlocked(issue, [issue])).toBe(false);
	});

	test("returns true when a dep is non-shipped (idea)", () => {
		const dep = makeEntry("B", "idea");
		const issue = makeEntry("A", "idea", ["B"]);
		expect(isBlocked(issue, [dep, issue])).toBe(true);
	});

	test("returns true when a dep is non-shipped (planned)", () => {
		const dep = makeEntry("B", "planned");
		const issue = makeEntry("A", "idea", ["B"]);
		expect(isBlocked(issue, [dep, issue])).toBe(true);
	});

	test("returns false when all deps are shipped", () => {
		const dep = makeEntry("B", "shipped");
		const issue = makeEntry("A", "idea", ["B"]);
		expect(isBlocked(issue, [dep, issue])).toBe(false);
	});

	test("returns false when dep is missing from backlog (not isBlocked's concern)", () => {
		const issue = makeEntry("A", "idea", ["UNKNOWN"]);
		expect(isBlocked(issue, [issue])).toBe(false);
	});

	test("returns true when at least one dep is non-shipped among multiple", () => {
		const shipped = makeEntry("B", "shipped");
		const unshipped = makeEntry("C", "specified");
		const issue = makeEntry("A", "idea", ["B", "C"]);
		expect(isBlocked(issue, [shipped, unshipped, issue])).toBe(true);
	});

	test("returns false when all multiple deps are shipped", () => {
		const b = makeEntry("B", "shipped");
		const c = makeEntry("C", "shipped");
		const issue = makeEntry("A", "idea", ["B", "C"]);
		expect(isBlocked(issue, [b, c, issue])).toBe(false);
	});
});

describe("deriveBlocks", () => {
	test("empty backlog returns empty map", () => {
		expect(deriveBlocks([])).toEqual(new Map());
	});

	test("single entry with no blockedBy has empty reverse list", () => {
		const a = makeEntry("A", "idea");
		const result = deriveBlocks([a]);
		expect(result.get("A")).toEqual([]);
	});

	test("builds correct reverse index", () => {
		const a = makeEntry("A", "idea");
		const b = makeEntry("B", "idea", ["A"]);
		const c = makeEntry("C", "idea", ["A"]);
		const result = deriveBlocks([a, b, c]);
		// A is blocked by both B and C
		expect(result.get("A")).toEqual(["B", "C"]);
		// B and C block nothing
		expect(result.get("B")).toEqual([]);
		expect(result.get("C")).toEqual([]);
	});

	test("handles blockedBy referencing an id not in backlog", () => {
		const a = makeEntry("A", "idea", ["OUTSIDE"]);
		const result = deriveBlocks([a]);
		// OUTSIDE still gets a reverse entry pointing to A
		expect(result.get("OUTSIDE")).toEqual(["A"]);
		expect(result.get("A")).toEqual([]);
	});

	test("multiple deps per entry", () => {
		const x = makeEntry("X", "shipped");
		const y = makeEntry("Y", "shipped");
		const z = makeEntry("Z", "idea", ["X", "Y"]);
		const result = deriveBlocks([x, y, z]);
		expect(result.get("X")).toEqual(["Z"]);
		expect(result.get("Y")).toEqual(["Z"]);
		expect(result.get("Z")).toEqual([]);
	});
});

describe("checkReferentialIntegrity", () => {
	test("returns ok:true for a clean backlog", () => {
		const a = makeEntry("A", "shipped");
		const b = makeEntry("B", "idea", ["A"]);
		const result = checkReferentialIntegrity([a, b]);
		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("returns ok:true for empty backlog", () => {
		expect(checkReferentialIntegrity([])).toEqual({ ok: true, errors: [] });
	});

	test("flags a missing-id dependency", () => {
		const a = makeEntry("A", "idea", ["MISSING"]);
		const result = checkReferentialIntegrity([a]);
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("MISSING");
		expect(result.errors[0]).toContain("A");
	});

	test("flags a self-reference", () => {
		const a = makeEntry("A", "idea", ["A"]);
		const result = checkReferentialIntegrity([a]);
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("Self-reference");
		expect(result.errors[0]).toContain("A");
	});

	test("flags both missing-id and self-reference in the same backlog", () => {
		const a = makeEntry("A", "idea", ["A", "GHOST"]);
		const result = checkReferentialIntegrity([a]);
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(2);
	});

	test("does not flag a valid cross-reference", () => {
		const a = makeEntry("A", "shipped");
		const b = makeEntry("B", "idea", ["A"]);
		const c = makeEntry("C", "planned", ["A", "B"]);
		const result = checkReferentialIntegrity([a, b, c]);
		expect(result.ok).toBe(true);
	});
});
