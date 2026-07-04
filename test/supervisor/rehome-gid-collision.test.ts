// test/supervisor/rehome-gid-collision.test.ts
//
// Deterministic file-assert tests for the re-home RUN block in
// .devcontainer/Dockerfile (US-001, CAM-183).
//
// These tests assert the getent-branch shape without requiring a Docker daemon.
// Mirrors the file-assert oracle conventions in claude-config-bake.test.ts.
//
// Assertions:
//   A1 - No groupmod -n rename and no _rehomed token (rename guard is gone)
//   A2 - getent branch is present: `getent group "$HOST_GID"`
//   A3 - When group exists branch: `usermod -u "$HOST_UID" -g "$HOST_GID" bun`
//   A4 - When group absent branch: `groupmod -g "$HOST_GID" bun`
//   A5 - Trailing chown is preserved: `chown -R "$HOST_UID:$HOST_GID" /home/bun`

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const dockerfilePath = join(ROOT, '.devcontainer', 'Dockerfile');
const dockerfileContent = readFileSync(dockerfilePath, 'utf8');

// ---------------------------------------------------------------------------
// A1: rename-based collision guard is gone
// ---------------------------------------------------------------------------

describe('rename guard removed (A1)', () => {
	test('does not contain groupmod -n (group rename)', () => {
		expect(dockerfileContent).not.toContain('groupmod -n');
	});

	test('does not contain _rehomed group-name suffix', () => {
		expect(dockerfileContent).not.toContain('_rehomed');
	});
});

// ---------------------------------------------------------------------------
// A2: getent branch is present
// ---------------------------------------------------------------------------

describe('getent branch present (A2)', () => {
	test('contains getent group "$HOST_GID"', () => {
		expect(dockerfileContent).toContain('getent group "$HOST_GID"');
	});
});

// ---------------------------------------------------------------------------
// A3: group-exists branch uses usermod -g to switch primary gid
// ---------------------------------------------------------------------------

describe('group-exists branch (A3)', () => {
	test('contains usermod -u "$HOST_UID" -g "$HOST_GID" bun', () => {
		expect(dockerfileContent).toContain('usermod -u "$HOST_UID" -g "$HOST_GID" bun');
	});
});

// ---------------------------------------------------------------------------
// A4: group-absent branch uses groupmod first, then usermod
// ---------------------------------------------------------------------------

describe('group-absent branch (A4)', () => {
	test('contains groupmod -g "$HOST_GID" bun', () => {
		expect(dockerfileContent).toContain('groupmod -g "$HOST_GID" bun');
	});

	test('contains usermod -u "$HOST_UID" bun (uid-only form for absent-group path)', () => {
		expect(dockerfileContent).toContain('usermod -u "$HOST_UID" bun');
	});
});

// ---------------------------------------------------------------------------
// A5: trailing chown is preserved
// ---------------------------------------------------------------------------

describe('trailing chown preserved (A5)', () => {
	test('contains chown -R "$HOST_UID:$HOST_GID" /home/bun', () => {
		expect(dockerfileContent).toContain('chown -R "$HOST_UID:$HOST_GID" /home/bun');
	});
});
