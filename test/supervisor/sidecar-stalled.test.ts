// test/supervisor/sidecar-stalled.test.ts
//
// Tests for the durable sidecar-stalled marker (US-001, CAM-207).

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, test, expect } from 'bun:test';

import {
	SIDECAR_STALLED_FILENAME,
	readSidecarStalledMarker,
	writeSidecarStalledMarker,
	removeSidecarStalledMarker,
	type SidecarStalledMarker,
} from '../../src/supervisor/sidecar-stalled.ts';

describe('sidecar-stalled marker: round-trip (US-001, CAM-207)', () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cam-sidecar-stalled-'));
		filePath = join(tempDir, SIDECAR_STALLED_FILENAME);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('SIDECAR_STALLED_FILENAME is the expected literal', () => {
		expect(SIDECAR_STALLED_FILENAME).toBe('.cam-sidecar-stalled.json');
	});

	test('write then read round-trips the payload intact (firewall-init-failed)', () => {
		const marker: SidecarStalledMarker = {
			reason: 'firewall-init-failed',
			detail: 'iptables: Permission denied',
			writtenAt: '2026-07-11T21:00:00Z',
		};

		writeSidecarStalledMarker(filePath, marker);

		expect(readSidecarStalledMarker(filePath)).toEqual(marker);
	});

	test('write then read round-trips the payload intact (sidecar-died)', () => {
		const marker: SidecarStalledMarker = {
			reason: 'sidecar-died',
			detail: 'process exited unexpectedly',
			writtenAt: '2026-07-11T21:00:00Z',
		};

		writeSidecarStalledMarker(filePath, marker);

		expect(readSidecarStalledMarker(filePath)).toEqual(marker);
	});

	test('write then read round-trips the payload intact (container-auth-unavailable)', () => {
		const marker: SidecarStalledMarker = {
			reason: 'container-auth-unavailable',
			detail: 'auth preflight: no credentials found',
			writtenAt: '2026-07-22T21:00:00Z',
		};

		writeSidecarStalledMarker(filePath, marker);

		expect(readSidecarStalledMarker(filePath)).toEqual(marker);
	});

	test('readSidecarStalledMarker returns null for an absent file', () => {
		expect(readSidecarStalledMarker(filePath)).toBeNull();
	});

	test('readSidecarStalledMarker returns null for malformed JSON', () => {
		writeFileSync(filePath, 'NOT VALID JSON {{{{', 'utf8');
		expect(readSidecarStalledMarker(filePath)).toBeNull();
	});

	test('readSidecarStalledMarker returns null for a JSON array', () => {
		writeFileSync(filePath, JSON.stringify([1, 2, 3]), 'utf8');
		expect(readSidecarStalledMarker(filePath)).toBeNull();
	});

	test('readSidecarStalledMarker returns null when required fields are missing', () => {
		writeFileSync(filePath, JSON.stringify({ reason: 'firewall-init-failed' }), 'utf8');
		expect(readSidecarStalledMarker(filePath)).toBeNull();
	});

	test('readSidecarStalledMarker returns null on a shape-guard failure (wrong type)', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				reason: 'firewall-init-failed',
				detail: 123,
				writtenAt: '2026-07-11T21:00:00Z',
			}),
			'utf8',
		);
		expect(readSidecarStalledMarker(filePath)).toBeNull();
	});

	test('readSidecarStalledMarker returns null when reason is not a recognized discriminator', () => {
		writeFileSync(
			filePath,
			JSON.stringify({
				reason: 'not-a-real-reason',
				detail: 'x',
				writtenAt: '2026-07-11T21:00:00Z',
			}),
			'utf8',
		);
		expect(readSidecarStalledMarker(filePath)).toBeNull();
	});

	test('writeSidecarStalledMarker overwrites a previous marker', () => {
		const first: SidecarStalledMarker = {
			reason: 'firewall-init-failed',
			detail: 'first',
			writtenAt: '2026-07-11T20:00:00Z',
		};
		const second: SidecarStalledMarker = {
			reason: 'firewall-init-failed',
			detail: 'second',
			writtenAt: '2026-07-11T21:00:00Z',
		};

		writeSidecarStalledMarker(filePath, first);
		writeSidecarStalledMarker(filePath, second);

		expect(readSidecarStalledMarker(filePath)).toEqual(second);
	});

	test('removeSidecarStalledMarker deletes the file', () => {
		writeSidecarStalledMarker(filePath, {
			reason: 'firewall-init-failed',
			detail: 'x',
			writtenAt: '2026-07-11T21:00:00Z',
		});
		expect(existsSync(filePath)).toBe(true);

		removeSidecarStalledMarker(filePath);

		expect(existsSync(filePath)).toBe(false);
	});

	test('removeSidecarStalledMarker on an absent file is a silent no-op', () => {
		expect(existsSync(filePath)).toBe(false);
		expect(() => removeSidecarStalledMarker(filePath)).not.toThrow();
		expect(existsSync(filePath)).toBe(false);
	});
});
