// test/release-workflow.test.ts
//
// Static-source guard for .github/workflows/release.yml (US-R1-002, CAM-495
// review round). This mirrors test/build-release-smoke.test.ts and
// test/ci-workflow.test.ts: it reads the committed workflow source and pins
// its shape, no compiled binary or GitHub Actions run needed.
//
// Why this guard exists: scripts/check-ci-parity.ts's CI_YML_PATH constant
// only ever reads .github/workflows/ci.yml (by design, patterns.md:1190), so
// release.yml is structurally invisible to that gate. Before this test,
// `grep -rln 'attest|SHA256SUMS' test/` matched only the install.sh and
// build-release.sh guards -- nothing pinned release.yml itself. Because
// install.sh (US-004/US-R1-001) is fail-closed on a missing checksum
// manifest, silently dropping `dist/SHA256SUMS.txt` from the `gh release
// create` argument list -- or deleting the attest step / its permissions --
// would make every subsequent Release uninstallable, and release.yml only
// executes on a version-tag push, so no PR-time CI run would catch it first.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKFLOW_PATH = resolve(
	import.meta.dir,
	'..',
	'.github',
	'workflows',
	'release.yml',
);
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

// The `gh release create` invocation is a multi-line, backslash-continued
// `run: |` block. Slice from the invocation to the next step boundary
// (`      - name:` at the job's step indentation) so assertions are scoped
// to that one command, not the whole file.
const releaseCreateIdx = workflow.indexOf('gh release create');
const nextStepIdx = workflow.indexOf('\n      - name:', releaseCreateIdx);
const releaseCreateBlock = workflow.slice(
	releaseCreateIdx,
	nextStepIdx === -1 ? workflow.length : nextStepIdx,
);

describe('release.yml gh release create invocation (US-R1-002, CAM-495)', () => {
	test('the invocation is present', () => {
		expect(releaseCreateIdx).toBeGreaterThan(-1);
	});

	test('publishes the four cross-compiled binaries', () => {
		expect(releaseCreateBlock).toContain('dist/gateship-darwin-arm64');
		expect(releaseCreateBlock).toContain('dist/gateship-darwin-x64');
		expect(releaseCreateBlock).toContain('dist/gateship-linux-x64');
		expect(releaseCreateBlock).toContain('dist/gateship-linux-arm64');
	});

	test('publishes dist/SHA256SUMS.txt in the same invocation as the binaries', () => {
		// This is the regression this story exists to catch: dropping the
		// manifest from the argument list breaks install.sh's fail-closed
		// checksum verification (US-004/US-R1-001) for every future Release.
		expect(releaseCreateBlock).toContain('dist/SHA256SUMS.txt');
	});
});

describe('release.yml attest step (US-R1-002, CAM-495)', () => {
	test('runs actions/attest-build-provenance for the four binaries', () => {
		expect(workflow).toContain('uses: actions/attest-build-provenance@v4');
		expect(workflow).toContain('dist/gateship-darwin-arm64');
		expect(workflow).toContain('dist/gateship-darwin-x64');
		expect(workflow).toContain('dist/gateship-linux-x64');
		expect(workflow).toContain('dist/gateship-linux-arm64');
	});

	test('the job carries the permissions the attest action requires', () => {
		const permissionsIdx = workflow.indexOf('permissions:');
		expect(permissionsIdx).toBeGreaterThan(-1);
		const jobsIdx = workflow.indexOf('\njobs:', permissionsIdx);
		const permissionsBlock = workflow.slice(
			permissionsIdx,
			jobsIdx === -1 ? workflow.length : jobsIdx,
		);
		// attest-build-provenance needs id-token: write to mint the OIDC token
		// and attestations: write to publish the attestation; contents: write
		// is needed by gh release create itself.
		expect(permissionsBlock).toContain('id-token: write');
		expect(permissionsBlock).toContain('attestations: write');
		expect(permissionsBlock).toContain('contents: write');
	});
});
