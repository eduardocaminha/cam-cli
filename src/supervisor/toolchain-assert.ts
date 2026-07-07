// src/supervisor/toolchain-assert.ts
//
// Fail-closed container toolchain assert (US-006, CAM-201).
//
// Probes `bun --version` / `node --version` INSIDE the running cam-worker
// container via an injectable exec seam, and compares the result against the
// repo-pinned versions (`readPinnedBunVersion` / `readPinnedNodeVersion` from
// `src/config/toolchain.ts`). Returns a discriminated result; never throws.
//
// This is a pure, injectable helper (mirrors the `DockerProbe` /
// `ConfigSpawnFn` seam shapes in preflight-container.ts / container-config.ts).
// Wired into `ensureWorkerContainer` (ensure-container.ts, US-007): a mismatch
// triggers an auto-rebuild (docker rm -f + runWorkerContainer + re-assert); a
// rebuild failure or a still-mismatching re-assert throws `ToolchainMismatchError`
// below, caught (instanceof) by `runSidecar` / the per-cycle dispatch guard in
// `runSupervisor`, mirroring `FirewallError` / `ContainerConfigError`.
//
// noUncheckedIndexedAccess: no unguarded array indexing in this file.

import {
	readPinnedBunVersion,
	readPinnedNodeVersion,
	type ReadFileFn,
} from '../config/toolchain.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injectable exec seam for probing the container's toolchain versions.
 * Mirrors the `ConfigSpawnFn` shape (container-config.ts): captures stderr so
 * callers can surface diagnosis text on a probe failure.
 */
export type ToolchainExecFn = (
	cmd: string,
	args: string[],
) => { stdout: string; stderr: string; exitCode: number };

/** One detected mismatch between a pinned version and the container's actual version. */
export interface ToolchainMismatch {
	tool: 'bun' | 'node';
	/**
	 * Pinned version read from the repo (`.bun-version` / `.tool-versions`),
	 * or `null` when the pin file is missing/malformed (fail-closed).
	 */
	expected: string | null;
	/** Version actually reported by the container, or `null` when the probe failed. */
	actual: string | null;
}

/** Discriminated result of `assertContainerToolchain`. Never thrown; always returned. */
export type ToolchainAssertResult = { ok: true } | { ok: false; mismatches: ToolchainMismatch[] };

/** Options for `assertContainerToolchain`. */
export interface AssertContainerToolchainOptions {
	/** Name of the running cam-worker container to exec into (required). */
	containerName: string;

	/** Injectable exec seam (required). Never shells out by default. */
	execFn: ToolchainExecFn;

	/** Override the `.bun-version` path. Forwarded to `readPinnedBunVersion`. */
	bunVersionPath?: string;

	/** Override the `.tool-versions` path. Forwarded to `readPinnedNodeVersion`. */
	toolVersionsPath?: string;

	/** Injectable file reader. Forwarded to both pin readers. */
	readFileFn?: ReadFileFn;
}

// ---------------------------------------------------------------------------
// assertContainerToolchain
// ---------------------------------------------------------------------------

function stripLeadingV(raw: string): string {
	return raw.trim().replace(/^v/, '');
}

/**
 * Probe the running container's `bun --version` / `node --version` (via
 * `docker exec <containerName> bun --version` / `... node --version`) and
 * compare against the repo-pinned versions.
 *
 * Comparison rules:
 *   - bun:  exact string match (`bun --version` output has no leading 'v').
 *   - node: the container's `node --version` output (e.g. "v20.11.1") has its
 *           leading 'v' stripped before comparing to the pin (no prefix).
 *
 * Fail-closed: a missing or malformed pin file (`readPinnedBunVersion` /
 * `readPinnedNodeVersion` returning `null`) is treated as a MISMATCH, not a
 * silent pass -- an unreadable pin is exactly the condition this assert
 * exists to catch (a corrupted/missing pin file must not let a drifted
 * container run silently).
 *
 * Never throws: a non-zero exec exit is folded into the mismatch as
 * `actual: null`.
 */
export function assertContainerToolchain(
	opts: AssertContainerToolchainOptions,
): ToolchainAssertResult {
	const { containerName, execFn, bunVersionPath, toolVersionsPath, readFileFn } = opts;

	const mismatches: ToolchainMismatch[] = [];

	// --- bun ---
	const pinnedBun = readPinnedBunVersion(bunVersionPath, readFileFn);
	const bunProbe = execFn('docker', ['exec', containerName, 'bun', '--version']);
	const actualBun = bunProbe.exitCode === 0 ? bunProbe.stdout.trim() : null;
	if (pinnedBun === null || actualBun === null || actualBun !== pinnedBun) {
		mismatches.push({ tool: 'bun', expected: pinnedBun, actual: actualBun });
	}

	// --- node ---
	const pinnedNode = readPinnedNodeVersion(toolVersionsPath, readFileFn);
	const nodeProbe = execFn('docker', ['exec', containerName, 'node', '--version']);
	const actualNodeRaw = nodeProbe.exitCode === 0 ? nodeProbe.stdout.trim() : null;
	const actualNode = actualNodeRaw !== null ? stripLeadingV(actualNodeRaw) : null;
	if (pinnedNode === null || actualNode === null || actualNode !== pinnedNode) {
		mismatches.push({ tool: 'node', expected: pinnedNode, actual: actualNode });
	}

	if (mismatches.length > 0) {
		return { ok: false, mismatches };
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// ToolchainMismatchError
// ---------------------------------------------------------------------------

/** Render a short human-readable summary of a mismatch list for the error message. */
function summarizeMismatches(mismatches: ToolchainMismatch[]): string {
	return mismatches
		.map((m) => `${m.tool}: expected ${m.expected ?? '<unreadable pin>'}, got ${m.actual ?? '<probe failed>'}`)
		.join('; ');
}

/**
 * Typed error thrown by `ensureWorkerContainer` (US-007, CAM-201/CAM-192) when
 * the running container's toolchain still mismatches the repo pins after an
 * auto-rebuild attempt, or when the rebuild itself fails to converge.
 *
 * Caught specifically (instanceof check) in `runSidecar`, mirroring
 * `FirewallError` / `ContainerConfigError`: the sidecar aborts boot / blocks
 * dispatch fail-closed rather than letting a drifted container run silently.
 */
export class ToolchainMismatchError extends Error {
	/** The mismatches detected on the (possibly post-rebuild) re-assert. */
	mismatches: ToolchainMismatch[];

	constructor(mismatches: ToolchainMismatch[], stage: 'rebuild-failed' | 'still-mismatched') {
		const detail = summarizeMismatches(mismatches);
		const reason =
			stage === 'rebuild-failed'
				? `rebuild failed while recovering from a toolchain mismatch (${detail})`
				: `still mismatched after rebuild (${detail})`;
		super(`cam-worker container toolchain mismatch: ${reason}`);
		this.name = 'ToolchainMismatchError';
		this.mismatches = mismatches;
	}
}
