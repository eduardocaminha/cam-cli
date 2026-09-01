import type { DiagnosticSeverity } from './diagnostic-finding.ts';

/** One JSON row in runtime_settings retains these advisory, per-analyzer facts. */
export const DIAGNOSTIC_RATCHETS_KEY = 'diagnostic-ratchets';
export const DIAGNOSTIC_RATCHET_LIMIT = 20;

export interface DiagnosticSeverityCounts {
	error: number;
	warning: number;
	info: number;
}

export type DiagnosticRatchetOutcome = 'baseline' | 'unchanged' | 'improved' | 'regressed';

/** The last complete, comparable observation, kept independently from the next baseline. */
export interface DiagnosticRatchet {
	analyzer: string;
	analyzerVersion: string;
	sourceSha: string;
	baseline: DiagnosticSeverityCounts;
	observation: DiagnosticSeverityCounts;
	deltas: DiagnosticSeverityCounts;
	outcome: DiagnosticRatchetOutcome;
}

export interface PersistedDiagnosticRatchet {
	analyzer: string;
	analyzerVersion: string;
	activeBaseline: DiagnosticSeverityCounts;
	lastComparison: Omit<DiagnosticRatchet, 'analyzer'>;
}

export function emptyDiagnosticSeverityCounts(): DiagnosticSeverityCounts {
	return { error: 0, warning: 0, info: 0 };
}

export function countDiagnosticSeverities(
	findings: readonly { severity: DiagnosticSeverity }[],
): DiagnosticSeverityCounts {
	const counts = emptyDiagnosticSeverityCounts();
	for (const finding of findings) counts[finding.severity] += 1;
	return counts;
}

function isCounts(value: unknown): value is DiagnosticSeverityCounts {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return ['error', 'warning', 'info'].every((severity) =>
		typeof record[severity] === 'number'
		&& Number.isSafeInteger(record[severity])
		&& (record[severity] as number) >= 0,
	);
}

function isDeltas(value: unknown): value is DiagnosticSeverityCounts {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return ['error', 'warning', 'info'].every((severity) =>
		typeof record[severity] === 'number' && Number.isSafeInteger(record[severity]),
	);
}

function isText(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function isOutcome(value: unknown): value is DiagnosticRatchetOutcome {
	return value === 'baseline' || value === 'unchanged' || value === 'improved' || value === 'regressed';
}

/** Corrupt historic settings degrade to no baseline, so the next complete scan starts cleanly. */
export function normalizeDiagnosticRatchets(value: unknown): PersistedDiagnosticRatchet[] {
	if (!Array.isArray(value)) return [];
	const result: PersistedDiagnosticRatchet[] = [];
	const analyzers = new Set<string>();
	for (const candidate of value) {
		if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
		const item = candidate as Record<string, unknown>;
		const comparison = item['lastComparison'];
		if (comparison === null || typeof comparison !== 'object' || Array.isArray(comparison)) continue;
		const last = comparison as Record<string, unknown>;
		if (!isText(item['analyzer']) || !isText(item['analyzerVersion']) || !isCounts(item['activeBaseline'])
			|| !isText(last['analyzerVersion']) || !isText(last['sourceSha'])
			|| !isCounts(last['baseline']) || !isCounts(last['observation']) || !isDeltas(last['deltas'])
			|| !isOutcome(last['outcome']) || analyzers.has(item['analyzer'])) continue;
		analyzers.add(item['analyzer']);
		result.push({
			analyzer: item['analyzer'],
			analyzerVersion: item['analyzerVersion'],
			activeBaseline: item['activeBaseline'],
			lastComparison: {
				analyzerVersion: last['analyzerVersion'], sourceSha: last['sourceSha'],
				baseline: last['baseline'], observation: last['observation'], deltas: last['deltas'], outcome: last['outcome'],
			},
		});
		if (result.length === DIAGNOSTIC_RATCHET_LIMIT) break;
	}
	return result;
}

export function diagnosticRatchetSnapshot(entries: readonly PersistedDiagnosticRatchet[]): DiagnosticRatchet[] {
	return entries.map(({ analyzer, lastComparison }) => ({ analyzer, ...lastComparison }));
}

function deltas(baseline: DiagnosticSeverityCounts, observation: DiagnosticSeverityCounts): DiagnosticSeverityCounts {
	return {
		error: observation.error - baseline.error,
		warning: observation.warning - baseline.warning,
		info: observation.info - baseline.info,
	};
}

export function updateDiagnosticRatchet(
	entries: readonly PersistedDiagnosticRatchet[],
	input: { analyzer: string; analyzerVersion: string; sourceSha: string; observation: DiagnosticSeverityCounts },
): PersistedDiagnosticRatchet[] {
	const existing = entries.find((entry) => entry.analyzer === input.analyzer);
	const baseline = existing?.analyzerVersion === input.analyzerVersion
		? existing.activeBaseline
		: input.observation;
	const comparisonDeltas = deltas(baseline, input.observation);
	const outcome: DiagnosticRatchetOutcome = existing === undefined || existing.analyzerVersion !== input.analyzerVersion
		? 'baseline'
		: comparisonDeltas.error > 0 || comparisonDeltas.warning > 0 || comparisonDeltas.info > 0
			? 'regressed'
			: comparisonDeltas.error === 0 && comparisonDeltas.warning === 0 && comparisonDeltas.info === 0
				? 'unchanged'
				: 'improved';
	const next: PersistedDiagnosticRatchet = {
		analyzer: input.analyzer,
		analyzerVersion: input.analyzerVersion,
		activeBaseline: outcome === 'regressed' ? baseline : input.observation,
		lastComparison: {
			analyzerVersion: input.analyzerVersion,
			sourceSha: input.sourceSha,
			baseline,
			observation: input.observation,
			deltas: comparisonDeltas,
			outcome,
		},
	};
	return [next, ...entries.filter((entry) => entry.analyzer !== input.analyzer)].slice(0, DIAGNOSTIC_RATCHET_LIMIT);
}
