/**
 * Resolves a prd.issueNumber (full string id like 'CAM-154' OR a bare number
 * like 42) into the canonical issue id.
 *
 * Returns null when the input cannot be resolved to a valid id.
 * Never produces '<prefix>-0' or any other phantom id.
 */
export function resolveIssueId(
	issueNumber: number | string | null | undefined,
	prefix: string,
): string | null {
	if (issueNumber === null || issueNumber === undefined) {
		return null;
	}
	if (typeof issueNumber === "number") {
		if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
			return null;
		}
		return `${prefix}-${issueNumber}`;
	}
	// string: return verbatim only when it is already a well-formed issue id
	if (/^[A-Z]+-[0-9]+$/.test(issueNumber)) {
		return issueNumber;
	}
	return null;
}
