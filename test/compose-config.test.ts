// test/compose-config.test.ts
//
// Static-source guard for compose.yaml (GSHIP-657), mirroring
// test/release-workflow.test.ts: reads the committed file and pins its
// shape, no Docker daemon needed. compose.yaml must keep both the `build`
// block (the development path, and what the container image's own
// verification build uses) and an `image` tag that GATESHIP_IMAGE can
// redirect at a release-published tag instead of building.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COMPOSE_PATH = resolve(import.meta.dir, '..', 'compose.yaml');
const compose = readFileSync(COMPOSE_PATH, 'utf8');

describe('compose.yaml image consumption (GSHIP-657)', () => {
	test('image defaults to the unpublished local tag, so it builds unless overridden', () => {
		expect(compose).toContain('image: ${GATESHIP_IMAGE:-gateship:latest}');
	});

	test('keeps the local build block for development', () => {
		const buildIdx = compose.indexOf('\n    build:');
		expect(buildIdx).toBeGreaterThan(-1);
		const buildBlock = compose.slice(
			buildIdx,
			compose.indexOf('\n    image:'),
		);
		expect(buildBlock).toContain('context: .');
		expect(buildBlock).toContain('GSHIP_BUILD_SHA: ${GSHIP_BUILD_SHA:-}');
	});
});
