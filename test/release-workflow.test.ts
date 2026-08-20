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

// The attest step is a separate step from `gh release create`, above it in
// the job. Slice from the step's own `- name:` boundary to the next step
// boundary so the four subject-path assertions below are scoped to this
// step's `subject-path:` list, not satisfied merely because the same four
// paths also appear later in the `gh release create` block (US-R2-002,
// CAM-495 review round 2: the whole-workflow assertion was tautological --
// it stayed green even when the attest step's subject-path was mutated to
// a glob, `dist/gateship-*`, that never literally contains any of the four
// asserted substrings).
const attestStepIdx = workflow.indexOf('uses: actions/attest-build-provenance@v4');
const attestNextStepIdx = workflow.indexOf('\n      - name:', attestStepIdx);
const attestStepBlock = workflow.slice(
	attestStepIdx,
	attestNextStepIdx === -1 ? workflow.length : attestNextStepIdx,
);

describe('release.yml attest step (US-R1-002, CAM-495)', () => {
	test('runs actions/attest-build-provenance for the four binaries', () => {
		expect(attestStepIdx).toBeGreaterThan(-1);
		expect(attestStepBlock).toContain('dist/gateship-darwin-arm64');
		expect(attestStepBlock).toContain('dist/gateship-darwin-x64');
		expect(attestStepBlock).toContain('dist/gateship-linux-x64');
		expect(attestStepBlock).toContain('dist/gateship-linux-arm64');
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

// GSHIP-657: the release also builds and publishes the versioned container
// image, from its own job so it can run on ubuntu-latest -- the macOS-hosted
// runner used for the binaries above has no Docker daemon. Scoped the same
// way as the job above: sliced from the job's own key to the end of the
// file, since it is currently the last job.
const releaseImageJobIdx = workflow.indexOf('\n  release-image:');
const releaseImageJobBlock = workflow.slice(releaseImageJobIdx);

describe('release.yml release-image job (GSHIP-657)', () => {
	test('the job is present and runs on a Linux runner', () => {
		expect(releaseImageJobIdx).toBeGreaterThan(-1);
		expect(releaseImageJobBlock).toContain('runs-on: ubuntu-latest');
	});

	test('carries the permissions the registry push and attestation require', () => {
		// A job-level `permissions:` block replaces the workflow-level one
		// wholesale rather than adding to it, so this job has to repeat every
		// permission actions/attest-build-provenance@v4 needs -- the same three
		// the binaries' identical step gets from the workflow-level block above
		// (artifact-metadata, attestations, id-token) -- plus packages: write
		// for the registry push itself.
		expect(releaseImageJobBlock).toContain('artifact-metadata: write');
		expect(releaseImageJobBlock).toContain('attestations: write');
		expect(releaseImageJobBlock).toContain('id-token: write');
		expect(releaseImageJobBlock).toContain('packages: write');
	});

	test('bakes the release commit into the image via the same GSHIP_BUILD_SHA build-arg', () => {
		// Same variable name the Dockerfile ARG and build-release.sh's --define
		// both use, and the same value (github.sha) CI already passes when it
		// builds the image -- so resolveBootSourceSha's stale-service warning
		// behaves identically inside a released container.
		expect(releaseImageJobBlock).toContain(
			'GSHIP_BUILD_SHA=${{ github.sha }}',
		);
	});

	test('tags the published image with both the version and the commit', () => {
		const buildStepIdx = releaseImageJobBlock.indexOf(
			'uses: docker/build-push-action@v6',
		);
		expect(buildStepIdx).toBeGreaterThan(-1);
		const nextStepIdx = releaseImageJobBlock.indexOf(
			'\n      - name:',
			buildStepIdx,
		);
		const buildStepBlock = releaseImageJobBlock.slice(
			buildStepIdx,
			nextStepIdx === -1 ? releaseImageJobBlock.length : nextStepIdx,
		);
		expect(buildStepBlock).toContain('push: true');
		expect(buildStepBlock).toContain(
			'ghcr.io/${{ github.repository }}:${{ github.ref_name }}',
		);
		expect(buildStepBlock).toContain(
			'ghcr.io/${{ github.repository }}:${{ github.sha }}',
		);
	});

	test('attests build provenance for the pushed image digest', () => {
		const attestIdx = releaseImageJobBlock.indexOf(
			'uses: actions/attest-build-provenance@v4',
		);
		expect(attestIdx).toBeGreaterThan(-1);
		const attestBlock = releaseImageJobBlock.slice(attestIdx);
		expect(attestBlock).toContain('subject-name: ghcr.io/${{ github.repository }}');
		expect(attestBlock).toContain('subject-digest: ${{ steps.build.outputs.digest }}');
		expect(attestBlock).toContain('push-to-registry: true');
	});
});
