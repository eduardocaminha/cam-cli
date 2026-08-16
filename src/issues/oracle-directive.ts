/** Compatibility parser for backlog records created before direct `spec.verify`. */
export type LegacyOracleDirective =
	| { kind: 'command'; command: string }
	| { kind: 'unsupported'; name: string }
	| { kind: 'invalid' };

const OPENER = '[oracle:';

function extractLastDirective(criterion: string): string | null | undefined {
	const start = criterion.lastIndexOf(OPENER);
	if (start === -1) return null;
	const contentStart = start + OPENER.length;
	let depth = 0;
	for (let index = start; index < criterion.length; index += 1) {
		const character = criterion[index];
		if (character === '[') depth += 1;
		if (character === ']') depth -= 1;
		if (depth === 0) return criterion.slice(contentStart, index).trim();
	}
	return undefined;
}

export function parseOracleDirective(criterion: string): LegacyOracleDirective | null {
	const raw = extractLastDirective(criterion);
	if (raw === null) return null;
	if (raw === undefined || raw.length === 0) return { kind: 'invalid' };
	for (const prefix of ['named-command ', 'file-assert ']) {
		if (raw.startsWith(prefix)) {
			const command = raw.slice(prefix.length).trim();
			return command.length === 0 ? { kind: 'invalid' } : { kind: 'command', command };
		}
	}
	if (raw === 'reviewer-judgment' || raw.startsWith('tmux-pty ')) {
		return { kind: 'unsupported', name: raw.split(' ')[0] ?? raw };
	}
	if (raw === 'named-command' || raw === 'file-assert') return { kind: 'invalid' };
	return { kind: 'command', command: raw };
}
