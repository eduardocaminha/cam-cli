export interface NamedCommandOracle {
	kind: 'named-command';
	command: string;
}

export interface FileAssertOracle {
	kind: 'file-assert';
	command: string;
}

export interface ReviewerJudgmentOracle {
	kind: 'reviewer-judgment';
}

export interface TmuxPtyOracle {
	kind: 'tmux-pty';
	toolName: 'tmux-pty';
	artifactRef: string;
}

export interface NoRunnableOracle {
	kind: 'no-oracle';
	raw: string;
}

export interface MalformedOracle {
	kind: 'malformed';
	raw: string;
}

export type OracleDirective =
	| NamedCommandOracle
	| FileAssertOracle
	| ReviewerJudgmentOracle
	| TmuxPtyOracle
	| NoRunnableOracle
	| MalformedOracle;

export interface CriterionOracle {
	criterionIndex: number;
	directive: OracleDirective;
}

const ORACLE_OPENER = '[oracle:';

type ExtractedOracleMark =
	| { kind: 'absent' }
	| { kind: 'found'; raw: string }
	| { kind: 'unterminated'; raw: string };

function extractLastOracleRaw(criterion: string): ExtractedOracleMark {
	const openerStart = criterion.lastIndexOf(ORACLE_OPENER);
	if (openerStart === -1) return { kind: 'absent' };

	const innerStart = openerStart + ORACLE_OPENER.length;
	let depth = 0;
	for (let index = openerStart; index < criterion.length; index++) {
		const character = criterion[index];
		if (character === '[') depth++;
		else if (character === ']') {
			depth--;
			if (depth === 0) {
				return { kind: 'found', raw: criterion.slice(innerStart, index).trim() };
			}
		}
	}

	return { kind: 'unterminated', raw: criterion.slice(innerStart).trim() };
}

function classifyOracleText(raw: string): OracleDirective {
	if (raw === '') return { kind: 'no-oracle', raw };
	if (raw === 'reviewer-judgment') return { kind: 'reviewer-judgment' };

	if (raw.startsWith('file-assert ')) {
		const command = raw.slice('file-assert '.length).trim();
		return command === '' ? { kind: 'no-oracle', raw } : { kind: 'file-assert', command };
	}

	if (raw.startsWith('tmux-pty ')) {
		const artifactRef = raw.slice('tmux-pty '.length).trim();
		return artifactRef === ''
			? { kind: 'no-oracle', raw }
			: { kind: 'tmux-pty', toolName: 'tmux-pty', artifactRef };
	}

	if (raw.startsWith('named-command ')) {
		const command = raw.slice('named-command '.length).trim();
		return command === '' ? { kind: 'no-oracle', raw } : { kind: 'named-command', command };
	}

	if (raw === 'named-command') return { kind: 'no-oracle', raw };
	return { kind: 'named-command', command: raw };
}

export function parseOracleDirective(criterion: string): OracleDirective | null {
	const extracted = extractLastOracleRaw(criterion);
	if (extracted.kind === 'absent') return null;
	if (extracted.kind === 'unterminated') return { kind: 'malformed', raw: extracted.raw };
	return classifyOracleText(extracted.raw);
}

export function parseOracleDirectives(criteria: string[]): CriterionOracle[] {
	const directives: CriterionOracle[] = [];
	for (const [criterionIndex, criterion] of criteria.entries()) {
		const directive = parseOracleDirective(criterion);
		if (directive !== null) directives.push({ criterionIndex, directive });
	}
	return directives;
}
