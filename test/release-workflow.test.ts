// test/release-workflow.test.ts
//
// Static-source guard for .github/workflows/release.yml (US-R1-002, CAM-495
// review round; extended for GSHIP-665's automatic release path). This
// mirrors test/build-release-smoke.test.ts and test/ci-workflow.test.ts: it
// reads the committed workflow source and pins its shape, no compiled binary
// or GitHub Actions run needed.
//
// Why this guard exists: scripts/check-ci-parity.ts's CI_YML_PATH constant
// only ever reads .github/workflows/ci.yml (by design, patterns.md:1190), so
// release.yml is structurally invisible to that gate. Before this test,
// `grep -rln 'attest|SHA256SUMS' test/` matched only the install.sh and
// build-release.sh guards -- nothing pinned release.yml itself. Because
// install.sh (US-004/US-R1-001) is fail-closed on a missing checksum
// manifest, silently dropping `dist/SHA256SUMS.txt` from the release asset
// list -- or deleting the attest step / its permissions -- would make every
// subsequent Release uninstallable, and CI would not catch it first.

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

/** Slice from a step's own boundary to the next step boundary at the same (6-space) indentation. */
function stepBlock(haystack: string, marker: string): string {
	const idx = haystack.indexOf(marker);
	expect(idx).toBeGreaterThan(-1);
	const nextIdx = haystack.indexOf('\n      - name:', idx + 1);
	return haystack.slice(idx, nextIdx === -1 ? haystack.length : nextIdx);
}

describe('release.yml triggers (GSHIP-665)', () => {
	test('still supports a manually pushed v* tag', () => {
		const onIdx = workflow.indexOf('\non:');
		const concurrencyIdx = workflow.indexOf('\nconcurrency:', onIdx);
		const onBlock = workflow.slice(onIdx, concurrencyIdx === -1 ? workflow.length : concurrencyIdx);
		expect(onBlock).toContain('push:');
		expect(onBlock).toContain("- 'v*'");
	});

	test('also observes completed runs of the CI workflow', () => {
		const onIdx = workflow.indexOf('\non:');
		const concurrencyIdx = workflow.indexOf('\nconcurrency:', onIdx);
		const onBlock = workflow.slice(onIdx, concurrencyIdx === -1 ? workflow.length : concurrencyIdx);
		expect(onBlock).toContain('workflow_run:');
		expect(onBlock).toContain("workflows: ['CI']");
		expect(onBlock).toContain('types: [completed]');
	});

	test('carries a serial concurrency group so overlapping triggers cannot race the same version', () => {
		const concurrencyIdx = workflow.indexOf('\nconcurrency:');
		const jobsIdx = workflow.indexOf('\npermissions:', concurrencyIdx);
		expect(concurrencyIdx).toBeGreaterThan(-1);
		const concurrencyBlock = workflow.slice(concurrencyIdx, jobsIdx === -1 ? workflow.length : jobsIdx);
		expect(concurrencyBlock).toContain('group: release');
		expect(concurrencyBlock).toContain('cancel-in-progress: false');
	});
});

const resolveJobIdx = workflow.indexOf('\n  resolve-release:');
const releaseJobIdx = workflow.indexOf('\n  release:');
const resolveJobBlock = workflow.slice(resolveJobIdx, releaseJobIdx);

describe('release.yml resolve-release job (GSHIP-665)', () => {
	test('the job is present and runs before release/release-image', () => {
		expect(resolveJobIdx).toBeGreaterThan(-1);
		expect(releaseJobIdx).toBeGreaterThan(resolveJobIdx);
	});

	test('a manual tag push passes its own tag and commit straight through', () => {
		expect(resolveJobBlock).toContain(`if [[ "\${EVENT_NAME}" == "push" ]]; then`);
		expect(resolveJobBlock).toContain('echo "tag=${REF_NAME}" >> "$GITHUB_OUTPUT"');
		expect(resolveJobBlock).toContain('echo "sha=${PUSH_SHA}" >> "$GITHUB_OUTPUT"');
	});

	test('a manually pushed tag that only matches the looser v* trigger glob fails closed before any output is emitted', () => {
		// The `push: tags: v*` trigger glob matches `v1`, `v1.2` and
		// `v1.2.3-rc1` too, none of which are a valid release version. The
		// guard must run, and fail, before the first `echo ... >> "$GITHUB_OUTPUT"`
		// in the manual-path branch -- never emit a malformed tag downstream.
		const pushBranchIdx = resolveJobBlock.indexOf('if [[ "${EVENT_NAME}" == "push" ]]; then');
		const guardIdx = resolveJobBlock.indexOf(
			'if [[ ! "${REF_NAME}" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then',
		);
		const firstOutputIdx = resolveJobBlock.indexOf('echo "tag=${REF_NAME}"');
		expect(guardIdx).toBeGreaterThan(pushBranchIdx);
		expect(guardIdx).toBeLessThan(firstOutputIdx);
		expect(resolveJobBlock.slice(guardIdx, firstOutputIdx)).toContain('exit 1');
	});

	test('the automatic path requires the triggering CI run to have succeeded', () => {
		expect(resolveJobBlock).toContain(`if [[ "\${RUN_CONCLUSION}" != "success" ]]; then`);
	});

	test('the automatic path requires the triggering CI run to itself be a push', () => {
		expect(resolveJobBlock).toContain(`if [[ "\${RUN_EVENT}" != "push" ]]; then`);
	});

	test('the automatic path requires the head branch to be main', () => {
		expect(resolveJobBlock).toContain(`if [[ "\${RUN_HEAD_BRANCH}" != "main" ]]; then`);
	});

	test('the automatic path confirms the exact head sha via the commit-associated-pulls API', () => {
		expect(resolveJobBlock).toContain('repos/${REPO}/commits/${RUN_HEAD_SHA}/pulls');
		expect(resolveJobBlock).toContain('.merged_at != null');
		expect(resolveJobBlock).toContain('.base.ref == \\"main\\"');
		expect(resolveJobBlock).toContain('.merge_commit_sha == \\"${RUN_HEAD_SHA}\\"');
	});

	test('a rerun reuses a valid version tag already pointing at the commit instead of minting a second one', () => {
		const idempotencyIdx = resolveJobBlock.indexOf('EXISTING_TAG=');
		const tagCreateIdx = resolveJobBlock.indexOf('git tag "${NEXT_TAG}"');
		expect(idempotencyIdx).toBeGreaterThan(-1);
		expect(tagCreateIdx).toBeGreaterThan(idempotencyIdx);
		expect(resolveJobBlock).toContain(
			"git tag --points-at \"${RUN_HEAD_SHA}\" | grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+$'",
		);
	});

	test('the new tag is chosen with the extracted deterministic script and pushed by this job, not left to a tag-push retrigger', () => {
		expect(resolveJobBlock).toContain(
			"git tag -l 'v*' | bun run scripts/next-release-version.ts",
		);
		expect(resolveJobBlock).toContain('git tag "${NEXT_TAG}" "${RUN_HEAD_SHA}"');
		expect(resolveJobBlock).toContain('git push origin "refs/tags/${NEXT_TAG}"');
	});

	test('carries contents:write (to push the tag) and pull-requests:read (to query the pulls API)', () => {
		const permissionsIdx = resolveJobBlock.indexOf('permissions:');
		expect(permissionsIdx).toBeGreaterThan(-1);
		const stepsIdx = resolveJobBlock.indexOf('steps:', permissionsIdx);
		const permissionsBlock = resolveJobBlock.slice(permissionsIdx, stepsIdx);
		expect(permissionsBlock).toContain('contents: write');
		expect(permissionsBlock).toContain('pull-requests: read');
	});
});

describe('release.yml release job gating (GSHIP-665)', () => {
	const releaseImageJobIdx = workflow.indexOf('\n  release-image:');
	const releaseJobBlock = workflow.slice(releaseJobIdx, releaseImageJobIdx);

	test('only runs once resolve-release has produced a tag', () => {
		expect(releaseJobBlock).toContain('needs: [resolve-release]');
		expect(releaseJobBlock).toContain("if: needs.resolve-release.outputs.tag != ''");
	});

	test('checks out the exact resolved sha, never an implicit ref', () => {
		expect(releaseJobBlock).toContain('ref: ${{ needs.resolve-release.outputs.sha }}');
	});
});

describe('release.yml gh release publish step (US-R1-002, CAM-495, GSHIP-665)', () => {
	const publishBlock = stepBlock(workflow, '- name: Publish prerelease with the four binaries and checksum manifest');

	test('the invocation is present and uses the resolved tag, not github.ref_name', () => {
		expect(publishBlock).toContain('gh release create "$TAG"');
		expect(publishBlock).toContain('TAG: ${{ needs.resolve-release.outputs.tag }}');
	});

	test('publishes the four cross-compiled binaries and the checksum manifest', () => {
		expect(publishBlock).toContain('dist/gateship-darwin-arm64');
		expect(publishBlock).toContain('dist/gateship-darwin-x64');
		expect(publishBlock).toContain('dist/gateship-linux-x64');
		expect(publishBlock).toContain('dist/gateship-linux-arm64');
		// This is the regression this story exists to catch: dropping the
		// manifest from the asset list breaks install.sh's fail-closed checksum
		// verification (US-004/US-R1-001) for every future Release.
		expect(publishBlock).toContain('dist/SHA256SUMS.txt');
	});

	test('a rerun replaces existing release assets instead of failing on a duplicate tag', () => {
		expect(publishBlock).toContain('gh release view "$TAG"');
		expect(publishBlock).toContain('gh release upload "$TAG" "${ASSETS[@]}" --clobber');
	});
});

// The attest step is a separate step from the publish step, above it in the
// job. Slice from the step's own `- name:` boundary to the next step
// boundary so the four subject-path assertions below are scoped to this
// step's `subject-path:` list, not satisfied merely because the same four
// paths also appear later in the publish step (US-R2-002, CAM-495 review
// round 2: the whole-workflow assertion was tautological -- it stayed green
// even when the attest step's subject-path was mutated to a glob,
// `dist/gateship-*`, that never literally contains any of the four asserted
// substrings).
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

	test('the workflow carries the permissions the attest action requires', () => {
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

describe('release.yml release-image job (GSHIP-657, GSHIP-665, GSHIP-699)', () => {
	test('the job is present, runs on a Linux runner, and only after resolve-release has produced a tag', () => {
		expect(releaseImageJobIdx).toBeGreaterThan(-1);
		expect(releaseImageJobBlock).toContain('runs-on: ubuntu-latest');
		expect(releaseImageJobBlock).toContain('needs: [resolve-release]');
		expect(releaseImageJobBlock).toContain("if: needs.resolve-release.outputs.tag != ''");
	});

	test('checks out the exact resolved sha, never an implicit ref', () => {
		expect(releaseImageJobBlock).toContain('ref: ${{ needs.resolve-release.outputs.sha }}');
	});

	test('registers arm64 emulation before Buildx executes target-platform stages', () => {
		const qemuIdx = releaseImageJobBlock.indexOf(
			'uses: docker/setup-qemu-action@v3',
		);
		const buildxIdx = releaseImageJobBlock.indexOf(
			'uses: docker/setup-buildx-action@v3',
		);
		expect(qemuIdx).toBeGreaterThan(-1);
		expect(releaseImageJobBlock.slice(qemuIdx, buildxIdx)).toContain(
			'platforms: arm64',
		);
		expect(buildxIdx).toBeGreaterThan(qemuIdx);
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

	test('bakes the resolved commit into the image via the same GSHIP_BUILD_SHA build-arg', () => {
		// Same variable name the Dockerfile ARG and build-release.sh's --define
		// both use, so resolveBootSourceSha's stale-service warning behaves
		// identically inside a released container. Sourced from
		// resolve-release's own output, never github.sha directly: for the
		// automatic (workflow_run) trigger, github.sha is release.yml's own
		// checkout context, not the CI run's head commit.
		expect(releaseImageJobBlock).toContain(
			'GSHIP_BUILD_SHA=${{ needs.resolve-release.outputs.sha }}',
		);
	});

	test('bakes the resolved release version into the image via the GSHIP_RELEASE_VERSION build-arg (GSHIP-665)', () => {
		expect(releaseImageJobBlock).toContain(
			'GSHIP_RELEASE_VERSION=${{ needs.resolve-release.outputs.version }}',
		);
	});

	test('tags the published image with both the resolved version and the resolved commit', () => {
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
		expect(buildStepBlock).toContain('platforms: linux/amd64,linux/arm64');
		expect(buildStepBlock).toContain(
			'ghcr.io/${{ github.repository }}:${{ needs.resolve-release.outputs.tag }}',
		);
		expect(buildStepBlock).toContain(
			'ghcr.io/${{ github.repository }}:${{ needs.resolve-release.outputs.sha }}',
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
