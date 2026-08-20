export const DIAGNOSTIC_SCHEDULE_KEY = 'diagnostic-schedule';

export const DIAGNOSTIC_CADENCES = ['daily', 'weekly'] as const;
export type DiagnosticCadence = (typeof DIAGNOSTIC_CADENCES)[number];

export interface DiagnosticScheduleSettings {
	enabled: boolean;
	analyzer: string;
	cadence: DiagnosticCadence;
}

export interface DiagnosticScheduleStatus extends DiagnosticScheduleSettings {
	lastScanAt: string | null;
	nextRunAt: string | null;
	overdue: boolean;
}

const CADENCE_MS: Readonly<Record<DiagnosticCadence, number>> = {
	daily: 24 * 60 * 60 * 1_000,
	weekly: 7 * 24 * 60 * 60 * 1_000,
};

export function defaultDiagnosticSchedule(): DiagnosticScheduleSettings {
	return { enabled: false, analyzer: 'react', cadence: 'weekly' };
}

/** A missing or malformed persisted row remains safely off. */
export function normalizeDiagnosticSchedule(value: unknown): DiagnosticScheduleSettings {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return defaultDiagnosticSchedule();
	}
	const record = value as Record<string, unknown>;
	const analyzer = typeof record['analyzer'] === 'string' ? record['analyzer'].trim() : '';
	const cadence = record['cadence'];
	return {
		enabled: record['enabled'] === true,
		analyzer: analyzer.length > 0 && analyzer.length <= 100 ? analyzer : 'react',
		cadence: cadence === 'daily' ? 'daily' : 'weekly',
	};
}

/**
 * One next instant, never a backlog of missed intervals. Any diagnostic scan,
 * ad hoc or scheduled, resets the same project cadence.
 */
export function diagnosticScheduleStatus(
	settings: DiagnosticScheduleSettings,
	lastScanAt: string | null,
	now: string,
): DiagnosticScheduleStatus {
	if (!settings.enabled) {
		return { ...settings, lastScanAt, nextRunAt: null, overdue: false };
	}
	const nowMs = Date.parse(now);
	const lastScanMs = lastScanAt === null ? Number.NaN : Date.parse(lastScanAt);
	const nextRunMs = Number.isFinite(lastScanMs)
		? lastScanMs + CADENCE_MS[settings.cadence]
		: nowMs;
	const nextRunAt = Number.isFinite(nextRunMs) ? new Date(nextRunMs).toISOString() : now;
	return {
		...settings,
		lastScanAt,
		nextRunAt,
		overdue: !Number.isFinite(nowMs) || nextRunMs <= nowMs,
	};
}
