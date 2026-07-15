import { describe, expect, test } from 'bun:test';
import { waitForCondition } from './helpers/wait-for-condition';

describe('waitForCondition', () => {
	test('resolves once the predicate becomes true', async () => {
		let pollCount = 0;
		const readyAfter = 3;

		await waitForCondition(
			() => {
				pollCount += 1;
				return pollCount >= readyAfter;
			},
			{ timeoutMs: 200, intervalMs: 1 },
		);

		expect(pollCount).toBeGreaterThanOrEqual(readyAfter);
	});

	test('rejects when the predicate stays false past the timeout', async () => {
		let pollCount = 0;

		await expect(
			waitForCondition(
				() => {
					pollCount += 1;
					return false;
				},
				{ timeoutMs: 20, intervalMs: 1 },
			),
		).rejects.toThrow(/waitForCondition/);

		expect(pollCount).toBeGreaterThan(0);
	});

	test('supports an async predicate', async () => {
		let ready = false;
		setTimeout(() => {
			ready = true;
		}, 5);

		await waitForCondition(async () => Promise.resolve(ready), { timeoutMs: 200, intervalMs: 1 });

		expect(ready).toBe(true);
	});
});
