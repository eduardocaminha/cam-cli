import { createHash } from 'node:crypto';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';
export type DiagnosticScanState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type DiagnosticFindingStatus = 'pending' | 'dismissed' | 'promoted' | 'cleared';

export interface DiagnosticDraft {
	rule: string;
	severity: DiagnosticSeverity;
	file: string;
	evidence: string;
	line?: number;
	column?: number;
}

export interface DiagnosticScan {
	id: string;
	analyzer: string;
	analyzerVersion: string | null;
	sourceSha: string | null;
	state: DiagnosticScanState;
	coverageComplete: boolean;
	findingCount: number;
	error: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface DiagnosticFinding extends DiagnosticDraft {
	id: string;
	analyzer: string;
	toolVersion: string;
	sourceSha: string;
	status: DiagnosticFindingStatus;
	promotedIssueId: string | null;
	occurrenceCount: number;
	firstSeenAt: string;
	lastSeenAt: string;
	updatedAt: string;
}

export const DIAGNOSTIC_LIMITS = {
	maxFindingsPerScan: 500,
	rule: 200,
	file: 500,
	evidence: 2_000,
	toolVersion: 100,
} as const;

const SEVERITIES: readonly string[] = ['error', 'warning', 'info'];
const FINDING_STATUSES: readonly string[] = ['pending', 'dismissed', 'promoted', 'cleared'];
const SCAN_STATES: readonly string[] = ['queued', 'running', 'completed', 'failed', 'cancelled'];

export function isDiagnosticSeverity(value: string): value is DiagnosticSeverity {
	return SEVERITIES.includes(value);
}

export function isDiagnosticFindingStatus(value: string): value is DiagnosticFindingStatus {
	return FINDING_STATUSES.includes(value);
}

export function isDiagnosticScanState(value: string): value is DiagnosticScanState {
	return SCAN_STATES.includes(value);
}

function text(value: unknown, limit: number): string {
	return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function position(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

function normalizeDiagnosticDraft(value: unknown): DiagnosticDraft | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const rule = text(record['rule'], DIAGNOSTIC_LIMITS.rule);
	const file = text(record['file'], DIAGNOSTIC_LIMITS.file);
	const evidence = text(record['evidence'], DIAGNOSTIC_LIMITS.evidence);
	if (rule.length === 0 || file.length === 0 || evidence.length === 0) return null;
	const severityValue = record['severity'];
	const severity = typeof severityValue === 'string' && isDiagnosticSeverity(severityValue)
		? severityValue
		: 'info';
	const line = position(record['line']);
	const column = position(record['column']);
	return {
		rule,
		severity,
		file,
		evidence,
		...(line === undefined ? {} : { line }),
		...(column === undefined ? {} : { column }),
	};
}

/** Defensive adapter boundary: malformed findings are dropped, never persisted as invented data. */
export function normalizeDiagnosticDrafts(value: unknown): DiagnosticDraft[] {
	if (!Array.isArray(value)) return [];
	const unique = new Map<string, DiagnosticDraft>();
	for (const item of value) {
		const draft = normalizeDiagnosticDraft(item);
		if (draft === null) continue;
		unique.set(diagnosticFingerprint('', draft), draft);
		if (unique.size >= DIAGNOSTIC_LIMITS.maxFindingsPerScan) break;
	}
	return [...unique.values()];
}

/** Stable across scans and source SHAs; line movement alone does not create a second inbox item. */
export function diagnosticFingerprint(analyzer: string, draft: DiagnosticDraft): string {
	return createHash('sha256')
		.update(JSON.stringify([analyzer, draft.rule, draft.file, draft.evidence]))
		.digest('hex');
}

export type DiagnosticTransitionErrorCode =
	| 'diagnostic-finding-not-found'
	| 'diagnostic-finding-not-pending';

export class DiagnosticTransitionError extends Error {
	constructor(
		readonly code: DiagnosticTransitionErrorCode,
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = 'DiagnosticTransitionError';
	}
}
