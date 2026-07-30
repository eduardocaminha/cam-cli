import { expect, test, describe } from "bun:test";
import { findStoreReachingSearch } from "../../src/issues/self-contaminating-search.ts";

// ---------------------------------------------------------------------------
// findStoreReachingSearch
// ---------------------------------------------------------------------------

describe("findStoreReachingSearch", () => {
	// --- Store-reaching recursive searches (must be flagged) ---

	test("flags a recursive grep rooted at scripts", () => {
		const result = findStoreReachingSearch("grep -rl zzqqx scripts");
		expect(result).toEqual({ root: "scripts" });
	});

	test("flags a recursive grep rooted at .", () => {
		const result = findStoreReachingSearch("grep -rl zzqqx .");
		expect(result).toEqual({ root: "." });
	});

	test("flags rg (recursive by default) rooted at scripts/cam", () => {
		const result = findStoreReachingSearch("rg -l zzqqx scripts/cam");
		expect(result).toEqual({ root: "scripts/cam" });
	});

	test("flags a recursive grep with no positional root at all (defaults to cwd)", () => {
		const result = findStoreReachingSearch("grep -r zzqqx");
		expect(result).toEqual({ root: "." });
	});

	test("flags a recursive grep rooted exactly at scripts/cam/issues", () => {
		const result = findStoreReachingSearch("grep -rl zzqqx scripts/cam/issues");
		expect(result).toEqual({ root: "scripts/cam/issues" });
	});

	test("flags a recursive grep rooted at scripts/cam/issues with a trailing slash", () => {
		const result = findStoreReachingSearch("grep -rl zzqqx scripts/cam/issues/");
		expect(result).toEqual({ root: "scripts/cam/issues/" });
	});

	test("flags separate (non-bundled) -r and -l flags", () => {
		const result = findStoreReachingSearch("grep -r -l zzqqx scripts");
		expect(result).toEqual({ root: "scripts" });
	});

	test("flags --recursive long-flag form", () => {
		const result = findStoreReachingSearch("grep --recursive zzqqx scripts");
		expect(result).toEqual({ root: "scripts" });
	});

	test("flags the real CAM-460 AC2 shape (quoted alternation pattern, multi-root, redirection, pipe)", () => {
		const command =
			'test $(grep -rl "gh release create\\|action-gh-release" .github/workflows scripts 2>/dev/null | wc -l) -gt 0';
		const result = findStoreReachingSearch(command);
		expect(result).toEqual({ root: "scripts" });
	});

	// --- Legitimate forms (must NOT be flagged) ---

	test("accepts a pinpoint git show read (no search tool at all)", () => {
		const result = findStoreReachingSearch("git show main:scripts/cam/issues/CAM-0460.json");
		expect(result).toBeNull();
	});

	test("accepts an explicit --exclude-dir=issues exclusion even with a store-reaching root", () => {
		const result = findStoreReachingSearch(
			"grep -rl zzqqx .github/workflows scripts --exclude-dir=issues",
		);
		expect(result).toBeNull();
	});

	test("accepts the space-separated --exclude-dir issues exclusion form", () => {
		const result = findStoreReachingSearch("grep -rl zzqqx scripts --exclude-dir issues");
		expect(result).toBeNull();
	});

	test("accepts a docs/adr root (not an ancestor of the store)", () => {
		const result = findStoreReachingSearch("grep -rl zzqqx docs/adr/");
		expect(result).toBeNull();
	});

	test("accepts a single-file root under scripts that is not the store", () => {
		const result = findStoreReachingSearch("grep -rl zzqqx scripts/cam/patterns.md");
		expect(result).toBeNull();
	});

	test("accepts a non-recursive grep rooted at scripts (no -r/-R)", () => {
		const result = findStoreReachingSearch("grep zzqqx scripts/cam/issues/CAM-1.json");
		expect(result).toBeNull();
	});

	test("accepts a command with no search tool word at all", () => {
		const result = findStoreReachingSearch("bun run check:all");
		expect(result).toBeNull();
	});

	// --- Review round 1 (US-R1-001, CAM-474): command-position false positives ---

	test("accepts a tool word inside a quoted search needle (grep -q \"rg\" ...)", () => {
		const result = findStoreReachingSearch('grep -q "rg" scripts/cam/patterns.md');
		expect(result).toBeNull();
	});

	test("accepts a tool word as a hyphen-delimited segment of an unrelated token", () => {
		const result = findStoreReachingSearch("bun run gen-rg-report");
		expect(result).toBeNull();
	});

	test("accepts a tool word as a file extension segment of an unrelated token", () => {
		const result = findStoreReachingSearch("test -f docs/x.rg");
		expect(result).toBeNull();
	});

	test("accepts a tool word merely echoed as plain text, not invoked", () => {
		const result = findStoreReachingSearch('bash -c "echo rg"');
		expect(result).toBeNull();
	});

	test("still flags a genuine search hidden inside a $(...) command-substitution wrapper", () => {
		const result = findStoreReachingSearch('test $(grep -rl zzqqx scripts ) -gt 0');
		expect(result).toEqual({ root: "scripts" });
	});

	test("still flags a genuine search piped through xargs", () => {
		const result = findStoreReachingSearch("find . -type f | xargs rg zzqqx scripts");
		expect(result).toEqual({ root: "scripts" });
	});
});
