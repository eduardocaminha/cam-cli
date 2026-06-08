import { describe, expect, test } from "bun:test";
import { formatTokens, parseTranscriptUsage } from "../../src/transcript/usage.ts";

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
