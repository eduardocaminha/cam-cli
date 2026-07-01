// test/supervisor/preflight-container.test.ts
//
// Unit tests for `preflightWorkerContainer` in src/supervisor/preflight-container.ts.
//
// All Docker calls are driven through a fake `probe` function; no real daemon
// is touched. CI runs on macos-latest with no Docker installed.

import { describe, expect, test } from 'bun:test';
import {
	preflightWorkerContainer,
	type DockerProbe,
	type StatFn,
} from '../../src/supervisor/preflight-container.ts';

// ---------------------------------------------------------------------------
// Probe factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake `DockerProbe` that returns:
 *   - exit 0 for `docker info` when `daemonUp` is true, non-zero otherwise.
 *   - exit 0 for `docker image inspect <tag>` when `imagePresent` is true.
 *   - The `imageCreatedAt` string (ISO-8601) for the `--format={{.Created}}`
 *     variant of `docker image inspect`.
 */
function makeProbe(opts: {
	daemonUp: boolean;
	imagePresent: boolean;
	imageCreatedAt?: string;
}): DockerProbe {
	return (args: string[]) => {
		// `docker info` — daemon liveness check
		if (args[0] === 'info') {
			return { stdout: '', exitCode: opts.daemonUp ? 0 : 1 };
		}

		// `docker image inspect …` — image existence + creation-time checks
		if (args[0] === 'image' && args[1] === 'inspect') {
			// `--format={{.Created}}` variant: return the creation timestamp
			if (args.includes('--format={{.Created}}')) {
				return {
					stdout: opts.imageCreatedAt ?? '',
					exitCode: opts.imagePresent ? 0 : 1,
				};
			}
			// Plain inspect: just signal presence/absence
			return { stdout: '', exitCode: opts.imagePresent ? 0 : 1 };
		}

		// Unexpected call — fail loudly so tests notice
		throw new Error(`Unexpected probe call: docker ${args.join(' ')}`);
	};
}

/** A `StatFn` that always returns the given mtime, simulating a real file. */
function makeStatFn(mtimeMs: number): StatFn {
	return (_path: string) => ({ mtimeMs });
}

/** A `StatFn` that always returns null (file absent or stat error). */
const absentStatFn: StatFn = (_path: string) => null;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('preflightWorkerContainer', () => {
	// AC covered: daemon reachable + image current => ready
	test('returns ready:true when daemon is up and image is current', () => {
		const probe = makeProbe({ daemonUp: true, imagePresent: true });
		const result = preflightWorkerContainer({ probe });
		expect(result).toEqual({ ready: true });
	});

	// AC covered: daemon unreachable => not-ready with a daemon reason
	test('returns daemon-unreachable when docker info exits non-zero', () => {
		const probe = makeProbe({ daemonUp: false, imagePresent: false });
		const result = preflightWorkerContainer({ probe });
		expect(result.ready).toBe(false);
		if (!result.ready) {
			expect(result.reason).toBe('daemon-unreachable');
		}
	});

	// AC covered: image missing => not-ready with an image reason
	test('returns image-missing when daemon is up but image does not exist', () => {
		const probe = makeProbe({ daemonUp: true, imagePresent: false });
		const result = preflightWorkerContainer({ probe });
		expect(result.ready).toBe(false);
		if (!result.ready) {
			expect(result.reason).toBe('image-missing');
		}
	});

	// AC covered: image stale => not-ready with an image reason
	test('returns image-stale when dockerfile is newer than the image', () => {
		const imageCreatedAt = new Date('2025-01-01T00:00:00Z').toISOString();
		const probe = makeProbe({ daemonUp: true, imagePresent: true, imageCreatedAt });

		// Dockerfile mtime is 1 second AFTER the image was created => stale
		const dockerfileMtime = new Date('2025-01-01T00:00:01Z').getTime();
		const statFn = makeStatFn(dockerfileMtime);

		const result = preflightWorkerContainer({ probe, statFn });
		expect(result.ready).toBe(false);
		if (!result.ready) {
			expect(result.reason).toBe('image-stale');
		}
	});

	// Guard: image is NEWER than dockerfile => not stale, ready
	test('returns ready:true when image is newer than the dockerfile', () => {
		const imageCreatedAt = new Date('2025-06-01T12:00:00Z').toISOString();
		const probe = makeProbe({ daemonUp: true, imagePresent: true, imageCreatedAt });

		// Dockerfile mtime is 1 hour BEFORE the image => image is current
		const dockerfileMtime = new Date('2025-06-01T11:00:00Z').getTime();
		const statFn = makeStatFn(dockerfileMtime);

		const result = preflightWorkerContainer({ probe, statFn });
		expect(result).toEqual({ ready: true });
	});

	// Guard: stale check skipped when statFn is absent
	test('skips stale check when statFn is not provided', () => {
		// Even if imageCreatedAt is very old, without statFn there is no comparison
		const probe = makeProbe({
			daemonUp: true,
			imagePresent: true,
			imageCreatedAt: new Date('2000-01-01T00:00:00Z').toISOString(),
		});
		// No statFn => stale check disabled
		const result = preflightWorkerContainer({ probe });
		expect(result).toEqual({ ready: true });
	});

	// Guard: stale check skipped when statFn returns null (file absent)
	test('skips stale check when statFn returns null (dockerfile absent)', () => {
		const imageCreatedAt = new Date('2000-01-01T00:00:00Z').toISOString();
		const probe = makeProbe({ daemonUp: true, imagePresent: true, imageCreatedAt });
		const result = preflightWorkerContainer({ probe, statFn: absentStatFn });
		expect(result).toEqual({ ready: true });
	});

	// Guard: custom imageTag is forwarded to the probe
	test('forwards a custom imageTag to the probe', () => {
		const seenArgs: string[][] = [];
		const probe: DockerProbe = (args: string[]) => {
			seenArgs.push(args);
			return { stdout: '', exitCode: 0 };
		};
		preflightWorkerContainer({ probe, imageTag: 'my-org/cam-worker:v2' });

		// The inspect call must reference the custom tag
		const inspectCall = seenArgs.find(
			(a) => a[0] === 'image' && a[1] === 'inspect' && !a.includes('--format={{.Created}}'),
		);
		expect(inspectCall).toContain('my-org/cam-worker:v2');
	});

	// Guard: daemon check fires before image check (short-circuit order)
	test('does not call image inspect when daemon is unreachable', () => {
		const called: string[] = [];
		const probe: DockerProbe = (args: string[]) => {
			called.push(args[0] ?? '');
			return { stdout: '', exitCode: args[0] === 'info' ? 1 : 0 };
		};
		preflightWorkerContainer({ probe });
		expect(called).toEqual(['info']);
	});
});
