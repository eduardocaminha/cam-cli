import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const script = readFileSync(resolve(import.meta.dir, '..', 'scripts', 'build-release.sh'), 'utf8');

describe('release build smoke', () => {
	test('checks version and init against the host binary from a temporary cwd', () => {
		expect(script).toContain('ACTUAL="$("${HOST_BIN}" --version)"');
		expect(script).toContain('SMOKE_DIR="$(mktemp -d)"');
		expect(script).toContain('cd "${SMOKE_DIR}" && "${BIN_ABS}" init </dev/null');
		expect(script).not.toContain('--issue-system');
	});

	test('hashes produced artifacts after the compile loop', () => {
		const loopEnd = script.indexOf('\ndone', script.indexOf('for entry in "${TARGETS[@]}"; do'));
		const manifest = script.indexOf('shasum -a 256 "${MANIFEST_NAMES[@]}"');
		expect(loopEnd).toBeGreaterThan(-1);
		expect(manifest).toBeGreaterThan(loopEnd);
	});

	test('prepares and verifies an install before replacing its destination', () => {
		const loop = script.slice(script.indexOf('for NAME in gateship gship; do'));
		const swap = loop.indexOf('mv -f "${STAGED}" "${DEST}"');
		for (const operation of [
			'cp "${HOST_BIN}" "${STAGED}"',
			'codesign -v "${STAGED}"',
			'chmod +x "${STAGED}"',
			'SMOKE_ACTUAL="$("${STAGED}" --version)"',
		]) {
			expect(loop.indexOf(operation)).toBeGreaterThan(-1);
			expect(loop.indexOf(operation)).toBeLessThan(swap);
		}
	});
});
