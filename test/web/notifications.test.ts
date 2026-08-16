import { describe, expect, test } from 'bun:test';

import { notificationForRunEvent } from '../../webui/src/notifications.ts';
import type { RunEventView, RunState } from '../../webui/src/run-view.ts';

function event(
	toState: RunState,
	kind: string,
	payload: Record<string, unknown> = {},
): RunEventView {
	return {
		seq: 1,
		runId: 'run-1',
		kind,
		fromState: 'working',
		toState,
		payload,
		createdAt: '2026-08-16T00:00:00.000Z',
	};
}

describe('run notifications', () => {
	test('alerts on operator decisions, retryable ship failures, failures and completion', () => {
		expect(notificationForRunEvent(event('waiting-user', 'run.waiting-user', {
			summary: 'Escolha o seam.',
		}))).toMatchObject({ title: 'Gateship precisa de você', body: 'Escolha o seam.' });
		expect(notificationForRunEvent(event('ready-to-ship', 'run.ship-failed', {
			error: 'checks red',
		}))).toMatchObject({ title: 'Ship precisa de nova tentativa', body: 'checks red' });
		expect(notificationForRunEvent(event('failed', 'run.verification-failed')))
			.toMatchObject({ title: 'Run falhou' });
		expect(notificationForRunEvent(event('done', 'run.shipped')))
			.toMatchObject({ title: 'Run concluído' });
	});

	test('does not alert on ordinary progress, automatic ready state, or operator cancellation', () => {
		expect(notificationForRunEvent(event('review', 'run.review-started'))).toBeNull();
		expect(notificationForRunEvent(event('ready-to-ship', 'run.review-clean'))).toBeNull();
		expect(notificationForRunEvent(event('interrupted', 'run.cancelled'))).toBeNull();
	});
});
