// test/helpers/with-fake-clock.test.ts
//
// Coverage for withFakeClock (US-001, CAM-362): proves the fake-clock
// installation, the advance/capture surface, and above all the leak-safety
// property motivating the extraction, restoration of BOTH patched globals
// even when the callback throws.

import { describe, expect, test } from 'bun:test';
import { withFakeClock } from './with-fake-clock.ts';

describe('withFakeClock', () => {
	test('installs a fake Date.now starting at 0, and advance(ms) moves it forward', () => {
		withFakeClock(({ advance }) => {
			expect(Date.now()).toBe(0);
			advance(1_000);
			expect(Date.now()).toBe(1_000);
			advance(500);
			expect(Date.now()).toBe(1_500);
		});
	});

	test('captures process.stderr.write chunks in order, decoding non-string chunks', () => {
		withFakeClock(({ chunks }) => {
			process.stderr.write('hello ');
			process.stderr.write(new TextEncoder().encode('world'));
			expect(chunks).toEqual(['hello ', 'world']);
		});
	});

	test('restores Date.now and process.stderr.write after the callback returns normally', () => {
		const originalNow = Date.now;
		const originalWrite = process.stderr.write;

		withFakeClock(({ advance }) => {
			advance(10);
		});

		expect(Date.now).toBe(originalNow);
		expect(process.stderr.write).toBe(originalWrite);
	});

	test('restores Date.now and process.stderr.write even when the callback throws (leak-safety)', () => {
		const originalNow = Date.now;
		const originalWrite = process.stderr.write;

		expect(() => {
			withFakeClock(() => {
				throw new Error('boom');
			});
		}).toThrow('boom');

		expect(Date.now).toBe(originalNow);
		expect(process.stderr.write).toBe(originalWrite);
	});
});
