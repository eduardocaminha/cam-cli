import { describe, expect, test } from "bun:test";
import { resolveIssueId } from "../../src/issues/resolve-id.ts";

describe("resolveIssueId", () => {
	// AC1: string matching /^[A-Z]+-[0-9]+$/ is returned verbatim
	test("returns string id verbatim when it matches the canonical pattern", () => {
		expect(resolveIssueId("CAM-154", "CAM")).toBe("CAM-154");
	});

	test("returns verbatim even when prefix param differs (string id is authoritative)", () => {
		expect(resolveIssueId("FOO-1", "BAR")).toBe("FOO-1");
	});

	// AC2: numeric issueNumber composes as prefix-n
	test("composes a numeric issueNumber as prefix-n", () => {
		expect(resolveIssueId(42, "CAM")).toBe("CAM-42");
	});

	test("composes a numeric 1 correctly", () => {
		expect(resolveIssueId(1, "CAM")).toBe("CAM-1");
	});

	// AC3: null / undefined / '' / 'not-an-id' return null, NEVER '<prefix>-0'
	test("returns null for null", () => {
		expect(resolveIssueId(null, "CAM")).toBeNull();
	});

	test("returns null for undefined", () => {
		expect(resolveIssueId(undefined, "CAM")).toBeNull();
	});

	test("returns null for empty string", () => {
		expect(resolveIssueId("", "CAM")).toBeNull();
	});

	test("returns null for a non-id string", () => {
		expect(resolveIssueId("not-an-id", "CAM")).toBeNull();
	});

	// Numeric 0 must never produce '<prefix>-0'
	test("returns null for numeric 0 (never produces prefix-0)", () => {
		expect(resolveIssueId(0, "CAM")).toBeNull();
	});

	test("returns null for negative numbers", () => {
		expect(resolveIssueId(-1, "CAM")).toBeNull();
	});

	// Malformed string ids also return null
	test("returns null for lowercase id string", () => {
		expect(resolveIssueId("cam-42", "CAM")).toBeNull();
	});

	test("returns null for string with no numeric suffix", () => {
		expect(resolveIssueId("CAM-", "CAM")).toBeNull();
	});

	test("returns null for plain number string", () => {
		expect(resolveIssueId("42", "CAM")).toBeNull();
	});
});
