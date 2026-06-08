import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatTokens, orchestratorTranscriptPath, parseTranscriptUsage, renderTokensLine } from "../../src/transcript/usage.ts";

// ---------------------------------------------------------------------------
// parseTranscriptUsage
// ---------------------------------------------------------------------------

describe("parseTranscriptUsage", () => {
	test("sums usage across assistant, sidechain, and skips malformed + non-usage lines", () => {
		const lines = [
			// assistant line with usage
			JSON.stringify({
				type: "assistant",
				sessionId: "s1",
				message: {
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_read_input_tokens: 20,
						cache_creation_input_tokens: 10,
					},
				},
			}),
			// another assistant line with usage
			JSON.stringify({
				type: "assistant",
				sessionId: "s1",
				message: {
					usage: {
						input_tokens: 200,
						output_tokens: 80,
						cache_read_input_tokens: 5,
						cache_creation_input_tokens: 3,
					},
				},
			}),
			// sidechain assistant line (subagent) — should also be summed
			JSON.stringify({
				type: "assistant",
				sessionId: "s2",
				isSidechain: true,
				message: {
					usage: {
						input_tokens: 300,
						output_tokens: 120,
						cache_read_input_tokens: 15,
						cache_creation_input_tokens: 7,
					},
				},
			}),
			// malformed JSON — skip silently
			"not valid json { oops",
			// line without message.usage — skip silently
			JSON.stringify({ type: "human", message: { content: "hello" } }),
		].join("\n");

		const result = parseTranscriptUsage(lines);

		expect(result.input).toBe(600);
		expect(result.output).toBe(250);
		expect(result.cacheRead).toBe(40);
		expect(result.cacheCreation).toBe(20);
	});

	test("returns zeros for empty input", () => {
		const result = parseTranscriptUsage("");
		expect(result.input).toBe(0);
		expect(result.output).toBe(0);
		expect(result.cacheRead).toBe(0);
		expect(result.cacheCreation).toBe(0);
	});

	test("returns zeros for all-malformed input", () => {
		const result = parseTranscriptUsage("garbage\n{broken\n");
		expect(result.input).toBe(0);
	});

	test("handles missing optional usage sub-fields as zero", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: {
				usage: {
					input_tokens: 50,
					// output_tokens, cache_* omitted
				},
			},
		});
		const result = parseTranscriptUsage(line);
		expect(result.input).toBe(50);
		expect(result.output).toBe(0);
		expect(result.cacheRead).toBe(0);
		expect(result.cacheCreation).toBe(0);
	});

	test("deduplicates lines sharing the same (message.id, requestId) — counts each request once not N times", () => {
		// Simulate a real transcript: 3 content-block lines for one assistant turn,
		// all carrying identical usage (the inflation pattern described in US-R2-001).
		const sharedUsage = {
			input_tokens: 1000,
			output_tokens: 200,
			cache_read_input_tokens: 500,
			cache_creation_input_tokens: 100,
		};
		const duplicateLine = JSON.stringify({
			type: "assistant",
			requestId: "req_abc123",
			message: {
				id: "msg_xyz789",
				usage: sharedUsage,
			},
		});
		// Same (message.id, requestId) repeated 3 times (thinking, text, tool_use blocks).
		const jsonl = [duplicateLine, duplicateLine, duplicateLine].join("\n");

		const result = parseTranscriptUsage(jsonl);

		// Must be counted ONCE, not 3x.
		expect(result.input).toBe(1000);
		expect(result.output).toBe(200);
		expect(result.cacheRead).toBe(500);
		expect(result.cacheCreation).toBe(100);
	});

	test("counts distinct (message.id, requestId) pairs independently", () => {
		// Two different requests in the same transcript — both must be counted.
		const req1 = JSON.stringify({
			type: "assistant",
			requestId: "req_111",
			message: { id: "msg_aaa", usage: { input_tokens: 300, output_tokens: 50 } },
		});
		const req2 = JSON.stringify({
			type: "assistant",
			requestId: "req_222",
			message: { id: "msg_bbb", usage: { input_tokens: 700, output_tokens: 150 } },
		});
		// req1 repeated twice, req2 once.
		const jsonl = [req1, req1, req2].join("\n");

		const result = parseTranscriptUsage(jsonl);

		// req1 deduped to 1 + req2 = 2 distinct requests.
		expect(result.input).toBe(1000);
		expect(result.output).toBe(200);
	});

	test("lines without message.id and requestId are each counted once (fallback)", () => {
		// Lines missing both dedup fields should not collide with each other.
		const line1 = JSON.stringify({
			type: "assistant",
			message: { usage: { input_tokens: 100, output_tokens: 10 } },
		});
		const line2 = JSON.stringify({
			type: "assistant",
			message: { usage: { input_tokens: 200, output_tokens: 20 } },
		});
		const jsonl = [line1, line2].join("\n");

		const result = parseTranscriptUsage(jsonl);

		// Both lines should be counted (no false collision).
		expect(result.input).toBe(300);
		expect(result.output).toBe(30);
	});
});

// ---------------------------------------------------------------------------
// orchestratorTranscriptPath
// ---------------------------------------------------------------------------

describe("orchestratorTranscriptPath", () => {
	function makeTmpProject(): { cwd: string; claudeDir: string } {
		const base = mkdtempSync(join(tmpdir(), "cam-orch-tp-"));
		const cwd = join(base, "project");
		const claudeDir = join(base, "claude-dir");
		mkdirSync(join(cwd, ".claude"), { recursive: true });
		mkdirSync(claudeDir, { recursive: true });
		return { cwd, claudeDir };
	}

	test("returns null when marker file is absent", () => {
		const { cwd, claudeDir } = makeTmpProject();
		// No .cam-orch-session written.
		expect(orchestratorTranscriptPath(cwd, claudeDir)).toBeNull();
	});

	test("returns null when marker file is empty", () => {
		const { cwd, claudeDir } = makeTmpProject();
		writeFileSync(join(cwd, ".claude", ".cam-orch-session"), "", "utf8");
		expect(orchestratorTranscriptPath(cwd, claudeDir)).toBeNull();
	});

	test("returns null when marker file contains only whitespace", () => {
		const { cwd, claudeDir } = makeTmpProject();
		writeFileSync(join(cwd, ".claude", ".cam-orch-session"), "  \n  ", "utf8");
		expect(orchestratorTranscriptPath(cwd, claudeDir)).toBeNull();
	});

	test("encodes non-alphanumeric chars in cwd as dashes", () => {
		const { claudeDir } = makeTmpProject();
		// Use a known cwd with special chars. We build the project dir ourselves.
		const base = mkdtempSync(join(tmpdir(), "cam-enc-"));
		// Simulate a cwd that has slashes, dots, dashes in its path.
		const cwd = join(base, "my.project");
		mkdirSync(join(cwd, ".claude"), { recursive: true });
		const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		writeFileSync(join(cwd, ".claude", ".cam-orch-session"), uuid, "utf8");

		const result = orchestratorTranscriptPath(cwd, claudeDir);
		expect(result).not.toBeNull();

		// The encoded segment should replace '/', '.', '-', etc. with '-'.
		const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
		const expected = join(claudeDir, "projects", encoded, `${uuid}.jsonl`);
		expect(result).toBe(expected);
	});

	test("honors the injected claudeDir (does not hardcode ~/.claude)", () => {
		const { cwd, claudeDir } = makeTmpProject();
		const uuid = "11111111-2222-3333-4444-555555555555";
		writeFileSync(join(cwd, ".claude", ".cam-orch-session"), uuid, "utf8");

		const result = orchestratorTranscriptPath(cwd, claudeDir);
		expect(result).not.toBeNull();
		// Path must be inside the injected claudeDir, not any hardcoded ~/.claude.
		expect(result!.startsWith(claudeDir)).toBe(true);
	});

	test("returns correct path for a standard uuid marker", () => {
		const { cwd, claudeDir } = makeTmpProject();
		const uuid = "deadbeef-1234-5678-abcd-000000000000";
		writeFileSync(join(cwd, ".claude", ".cam-orch-session"), uuid, "utf8");

		const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
		const expected = join(claudeDir, "projects", encoded, `${uuid}.jsonl`);
		expect(orchestratorTranscriptPath(cwd, claudeDir)).toBe(expected);
	});

	test("trims trailing newline from marker file content", () => {
		const { cwd, claudeDir } = makeTmpProject();
		const uuid = "deadbeef-1234-5678-abcd-000000000000";
		// Write with trailing newline (as writeFileSync in run.ts does not add one,
		// but shell echo / editors might).
		writeFileSync(join(cwd, ".claude", ".cam-orch-session"), `${uuid}\n`, "utf8");

		const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
		const expected = join(claudeDir, "projects", encoded, `${uuid}.jsonl`);
		expect(orchestratorTranscriptPath(cwd, claudeDir)).toBe(expected);
	});
});

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
	test("renders 0 as '0'", () => {
		expect(formatTokens(0)).toBe("0");
	});

	// Millions magnitude
	test("renders 1234567 as '1.2M'", () => {
		expect(formatTokens(1_234_567)).toBe("1.2M");
	});

	test("renders exactly 1000000 as '1.0M'", () => {
		expect(formatTokens(1_000_000)).toBe("1.0M");
	});

	// Edge: just under 1M
	test("renders 999999 as '1000k' (rounds up to next thousand)", () => {
		expect(formatTokens(999_999)).toBe("1000k");
	});

	// Thousands magnitude
	test("renders 340000 as '340k'", () => {
		expect(formatTokens(340_000)).toBe("340k");
	});

	test("renders exactly 1000 as '1k'", () => {
		expect(formatTokens(1_000)).toBe("1k");
	});

	// Edge: just under 1k
	test("renders 999 as '999'", () => {
		expect(formatTokens(999)).toBe("999");
	});

	// Raw integers below 1000
	test("renders 1 as '1'", () => {
		expect(formatTokens(1)).toBe("1");
	});

	test("renders 500 as '500'", () => {
		expect(formatTokens(500)).toBe("500");
	});
});

// ---------------------------------------------------------------------------
// renderTokensLine (US-004)
// ---------------------------------------------------------------------------

describe("renderTokensLine", () => {
	test("includes cached suffix when cacheRead > 0", () => {
		const line = renderTokensLine({
			input: 22_000,
			output: 5_000,
			cacheRead: 450_000,
			cacheCreation: 10_000,
		});
		// in = 22000 + 10000 + 450000 = 482000 -> 482k
		// cached = 450000 -> 450k (cacheRead only)
		// out = 5000 -> 5k
		expect(line).toBe("482k in (450k cached) · 5k out");
	});

	test("omits the cached suffix entirely when cacheRead is 0", () => {
		const line = renderTokensLine({
			input: 5_000,
			output: 1_000,
			cacheRead: 0,
			cacheCreation: 2_000,
		});
		// in = 5000 + 2000 + 0 = 7000 -> 7k; no cached suffix
		expect(line).toBe("7k in · 1k out");
	});

	test("cacheCreation is counted in 'in' total but never in 'cached'", () => {
		const line = renderTokensLine({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheCreation: 100_000,
		});
		// in = 100000 -> 100k; cached = 0 so no suffix; out = 0
		expect(line).toBe("100k in · 0 out");
	});

	test("renders '0 in · 0 out' when all fields are zero", () => {
		const line = renderTokensLine({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
		expect(line).toBe("0 in · 0 out");
	});

	test("shows cached suffix even when cached is small fraction of in", () => {
		const line = renderTokensLine({
			input: 100_000,
			output: 10_000,
			cacheRead: 1,
			cacheCreation: 0,
		});
		// cacheRead = 1 > 0, so suffix appears
		// in = 100001 -> 100k; cached = 1 -> 1; out = 10000 -> 10k
		expect(line).toContain("(1 cached)");
	});
});
