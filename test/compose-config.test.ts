// test/compose-config.test.ts
//
// Static-source guards for the container boundary (GSHIP-657), mirroring
// test/release-workflow.test.ts: reads the committed file and pins its
// shape, no Docker daemon needed. compose.yaml must keep both the `build`
// block (the development path, and what the container image's own
// verification build uses) and an `image` tag that GATESHIP_IMAGE can
// redirect at a release-published tag instead of building.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COMPOSE_PATH = resolve(import.meta.dir, '..', 'compose.yaml');
const DOCKERFILE_PATH = resolve(import.meta.dir, '..', 'Dockerfile');
const README_PATH = resolve(import.meta.dir, '..', 'README.md');
const CREDENTIALS_DOC_PATH = resolve(
	import.meta.dir,
	'..',
	'docs',
	'credentials-and-notifications.md',
);
const compose = readFileSync(COMPOSE_PATH, 'utf8');
const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf8');
const readme = readFileSync(README_PATH, 'utf8');
const credentialsDoc = readFileSync(CREDENTIALS_DOC_PATH, 'utf8');

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

	test('keeps the container boundary read-only and prevents privilege escalation', () => {
		expect(compose).toContain('read_only: true');
		expect(compose).toContain('- no-new-privileges:true');
		expect(compose).toContain('cap_drop:\n      - ALL');
		expect(compose).toContain('- /tmp:rw,nosuid,nodev,mode=1777');
	});

	test('uses long volume syntax so Windows drive-letter bind mounts remain portable', () => {
		expect(compose).toContain(
			'type: bind\n        source: ${GATESHIP_PROJECTS_DIR:-.}\n        target: /projects',
		);
		expect(compose).not.toContain('${GATESHIP_PROJECTS_DIR:-.}:/projects');
	});

	test('selects one repository relative to the projects mount and keeps project state on the bind', () => {
		expect(compose).toContain('working_dir: /projects/${GATESHIP_PROJECT_PATH:-.}');
		expect(compose).toContain('- gateship-state:/var/lib/gateship');
		expect(compose).not.toContain('gateship-state:/projects');
		expect(compose.match(/^\s+- gateship-state:/gm) ?? []).toHaveLength(1);
	});
});

describe('container provider CLI installation', () => {
	test('includes python3 in the minimal runtime package set', () => {
		expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends[\s\S]*\n\s+python3 \\\n/);
		expect(dockerfile).not.toContain('python ');
	});

	test('pins both provider CLIs to complete releases instead of mutable latest', () => {
		expect(dockerfile).toMatch(
			/https:\/\/claude\.ai\/install\.sh \| bash -s \d+\.\d+\.\d+\n/,
		);
		expect(dockerfile).not.toContain('https://claude.ai/install.sh | bash\n');
		expect(dockerfile).toMatch(/RUN bun add -g @openai\/codex@\d+\.\d+\.\d+\n/);
		expect(dockerfile).not.toContain('RUN bun add -g @openai/codex\n');
	});
});

describe('canonical portable container documentation (GSHIP-699)', () => {
	test('documents supported Docker hosts and equivalent POSIX and PowerShell startup', () => {
		expect(readme).toContain('Docker Desktop on Windows and macOS');
		expect(readme).toContain('Docker Engine on Linux');
		expect(readme).toContain('### POSIX shells');
		expect(readme).toContain('### PowerShell');
		expect(readme).toContain('$env:GATESHIP_PROJECTS_DIR = "C:\\path\\to\\projects"');
		expect(readme).toContain('$env:GATESHIP_PROJECT_PATH = "product"');
	});

	test('documents the supported headless Codex subscription login in the persisted CODEX_HOME', () => {
		const login = 'docker compose exec gateship codex login --device-auth';
		expect(readme).toContain(login);
		expect(credentialsDoc).toContain(login);
		expect(readme).not.toContain('ChatGPT sign-in does not work from inside this container');
		expect(credentialsDoc).not.toContain("ChatGPT sign-in cannot complete from\ninside the container");
	});
});
