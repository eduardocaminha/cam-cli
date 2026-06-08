/**
 * Pure transcript-usage parser.
 *
 * Parses a Claude Code transcript JSONL and sums token usage across all lines
 * that carry message.usage (assistant and sidechain lines).
 * Malformed / non-JSON lines and lines without message.usage are skipped silently.
 */

export interface TranscriptUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheCreation: number;
}

interface MessageUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

interface TranscriptLine {
	message?: {
		usage?: MessageUsage;
	};
}

function isTranscriptLine(val: unknown): val is TranscriptLine {
	return typeof val === "object" && val !== null;
}

function toNumber(val: unknown): number {
	return typeof val === "number" ? val : 0;
}

/**
 * Sums token usage across every line in the JSONL whose parsed JSON has
 * message.usage. Lines without message.usage or malformed JSON are skipped.
 */
export function parseTranscriptUsage(jsonl: string): TranscriptUsage {
	const result: TranscriptUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheCreation: 0,
	};

	const lines = jsonl.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "") continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// malformed JSON: skip silently
			continue;
		}

		if (!isTranscriptLine(parsed)) continue;

		const usage = parsed.message?.usage;
		if (usage === undefined || usage === null) continue;

		result.input += toNumber(usage.input_tokens);
		result.output += toNumber(usage.output_tokens);
		result.cacheRead += toNumber(usage.cache_read_input_tokens);
		result.cacheCreation += toNumber(usage.cache_creation_input_tokens);
	}

	return result;
}

/**
 * Formats a token count into a compact human-readable string.
 *
 * - >= 1_000_000: round to 1 decimal, append 'M'  (e.g. 1234567 -> '1.2M')
 * - >= 1_000:     round to integer, append 'k'     (e.g. 340000  -> '340k')
 * - < 1_000:      raw integer                       (e.g. 999     -> '999')
 * - 0:            '0'
 */
export function formatTokens(n: number): string {
	if (n === 0) return "0";
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(1)}M`;
	}
	if (n >= 1_000) {
		return `${Math.round(n / 1_000)}k`;
	}
	return `${n}`;
}
