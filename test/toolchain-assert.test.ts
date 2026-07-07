// test/toolchain-assert.test.ts
//
// Unit tests for `assertContainerToolchain` in src/supervisor/toolchain-assert.ts.
//
// All docker exec calls are driven through a fake `execFn`; no real daemon is
// touched. Pin-file reads are driven through a fake `readFileFn`; no real
// filesystem is touched.

import { describe, expect, test } from 'bun:test';
import {
	assertContainerToolchain,
	type ToolchainAssertResult,
	type ToolchainExecFn,
} from '../src/supervisor/toolchain-assert.ts';

const BUN_PIN_PATH = '/repo/.bun-version';
const NODE_PIN_PATH = '/repo/.tool-versions';

/** Fake readFileFn keyed by path; throws ENOENT-like for any other path. */
function makeReadFileFn(files: Record<string, string>): (path: string) => string {
	return (path: string) => {
		const content = files[path];
		if (content === undefined) {
			throw new Error(`ENOENT: ${path}`);
		}
		return content;
	};
}

/**
 * Fake docker exec seam. `bunVersion`/`nodeVersion` are the stdout the
 * container "reports"; pass `undefined` to simulate a non-zero exec exit
 * (probe failure).
 */
function makeExecFn(opts: { bunVersion?: string; nodeVersion?: string }): ToolchainExecFn {
	return (_cmd, args) => {
		if (args.includes('bun')) {
			return opts.bunVersion === undefined
				? { stdout: '', stderr: 'exec failed', exitCode: 1 }
				: { stdout: opts.bunVersion, stderr: '', exitCode: 0 };
		}
		if (args.includes('node')) {
			return opts.nodeVersion === undefined
				? { stdout: '', stderr: 'exec failed', exitCode: 1 }
				: { stdout: opts.nodeVersion, stderr: '', exitCode: 0 };
		}
		throw new Error(`Unexpected exec call: ${args.join(' ')}`);
	};
}

describe('assertContainerToolchain', () => {
	// AC covered: both versions match the pins => ok
	test('returns ok:true when bun and node versions match the pins', () => {
		const readFileFn = makeReadFileFn({
			[BUN_PIN_PATH]: '1.3.13\n',
			[NODE_PIN_PATH]: 'nodejs 20.11.1\n',
		});
		const execFn = makeExecFn({ bunVersion: '1.3.13\n', nodeVersion: 'v20.11.1\n' });

		const result = assertContainerToolchain({
			containerName: 'cam-worker',
			execFn,
			bunVersionPath: BUN_PIN_PATH,
			toolVersionsPath: NODE_PIN_PATH,
			readFileFn,
		});

		expect(result).toEqual({ ok: true });
	});

	// AC covered: node comparison strips the leading 'v' from the container's report
	test('strips leading v from node --version before comparing', () => {
		const readFileFn = makeReadFileFn({
			[BUN_PIN_PATH]: '1.3.13',
			[NODE_PIN_PATH]: 'nodejs 20.11.1',
		});
		const execFn = makeExecFn({ bunVersion: '1.3.13', nodeVersion: 'v20.11.1' });

		const result = assertContainerToolchain({
			containerName: 'cam-worker',
			execFn,
			bunVersionPath: BUN_PIN_PATH,
			toolVersionsPath: NODE_PIN_PATH,
			readFileFn,
		});

		expect(result.ok).toBe(true);
	});

	// AC covered: bun version drift is reported as a mismatch
	test('returns a bun mismatch when the container bun version differs from the pin', () => {
		const readFileFn = makeReadFileFn({
			[BUN_PIN_PATH]: '1.3.13',
			[NODE_PIN_PATH]: 'nodejs 20.11.1',
		});
		const execFn = makeExecFn({ bunVersion: '1.2.0', nodeVersion: 'v20.11.1' });

		const result = assertContainerToolchain({
			containerName: 'cam-worker',
			execFn,
			bunVersionPath: BUN_PIN_PATH,
			toolVersionsPath: NODE_PIN_PATH,
			readFileFn,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.mismatches).toEqual([
				{ tool: 'bun', expected: '1.3.13', actual: '1.2.0' },
			]);
		}
	});

	// AC covered: node version drift is reported as a mismatch
	test('returns a node mismatch when the container node version differs from the pin', () => {
		const readFileFn = makeReadFileFn({
			[BUN_PIN_PATH]: '1.3.13',
			[NODE_PIN_PATH]: 'nodejs 20.11.1',
		});
		const execFn = makeExecFn({ bunVersion: '1.3.13', nodeVersion: 'v18.19.0' });

		const result = assertContainerToolchain({
			containerName: 'cam-worker',
			execFn,
			bunVersionPath: BUN_PIN_PATH,
			toolVersionsPath: NODE_PIN_PATH,
			readFileFn,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.mismatches).toEqual([
				{ tool: 'node', expected: '20.11.1', actual: '18.19.0' },
			]);
		}
	});

	// AC covered: both drift => both mismatches reported
	test('returns both mismatches when bun and node both drift', () => {
		const readFileFn = makeReadFileFn({
			[BUN_PIN_PATH]: '1.3.13',
			[NODE_PIN_PATH]: 'nodejs 20.11.1',
		});
		const execFn = makeExecFn({ bunVersion: '1.2.0', nodeVersion: 'v18.19.0' });

		const result = assertContainerToolchain({
			containerName: 'cam-worker',
			execFn,
			bunVersionPath: BUN_PIN_PATH,
			toolVersionsPath: NODE_PIN_PATH,
			readFileFn,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.mismatches).toHaveLength(2);
		}
	});

	// AC covered: missing bun pin file fails closed (mismatch, not silent pass)
	test('fails closed when the .bun-version pin file is missing', () => {
		const readFileFn = makeReadFileFn({
			[NODE_PIN_PATH]: 'nodejs 20.11.1',
			// BUN_PIN_PATH intentionally absent
		});
		const execFn = makeExecFn({ bunVersion: '1.3.13', nodeVersion: 'v20.11.1' });

		const result = assertContainerToolchain({
			containerName: 'cam-worker',
			execFn,
			bunVersionPath: BUN_PIN_PATH,
			toolVersionsPath: NODE_PIN_PATH,
			readFileFn,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.mismatches).toEqual([
				{ tool: 'bun', expected: null, actual: '1.3.13' },
			]);
		}
	});

	// AC covered: malformed node pin file (no `nodejs` line) fails closed
	test('fails closed when the .tool-versions pin file is malformed', () => {
		const readFileFn = makeReadFileFn({
			[BUN_PIN_PATH]: '1.3.13',
			[NODE_PIN_PATH]: 'ruby 3.2.0\n', // no nodejs line
		});
		const execFn = makeExecFn({ bunVersion: '1.3.13', nodeVersion: 'v20.11.1' });

		const result = assertContainerToolchain({
			containerName: 'cam-worker',
			execFn,
			bunVersionPath: BUN_PIN_PATH,
			toolVersionsPath: NODE_PIN_PATH,
			readFileFn,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.mismatches).toEqual([
				{ tool: 'node', expected: null, actual: '20.11.1' },
			]);
		}
	});

	// AC covered: a failed exec probe (non-zero exit) never throws, folds to actual:null mismatch
	test('never throws on a failed exec probe; folds to actual:null mismatch', () => {
		const readFileFn = makeReadFileFn({
			[BUN_PIN_PATH]: '1.3.13',
			[NODE_PIN_PATH]: 'nodejs 20.11.1',
		});
		const execFn = makeExecFn({ nodeVersion: 'v20.11.1' }); // bun probe fails

		let result: ToolchainAssertResult | undefined;
		expect(() => {
			result = assertContainerToolchain({
				containerName: 'cam-worker',
				execFn,
				bunVersionPath: BUN_PIN_PATH,
				toolVersionsPath: NODE_PIN_PATH,
				readFileFn,
			});
		}).not.toThrow();

		expect(result?.ok).toBe(false);
		if (result !== undefined && !result.ok) {
			expect(result.mismatches).toEqual([
				{ tool: 'bun', expected: '1.3.13', actual: null },
			]);
		}
	});

	// Guard: containerName is forwarded into the exec argv
	test('forwards containerName into the docker exec argv', () => {
		const readFileFn = makeReadFileFn({
			[BUN_PIN_PATH]: '1.3.13',
			[NODE_PIN_PATH]: 'nodejs 20.11.1',
		});
		const seenArgs: string[][] = [];
		const execFn: ToolchainExecFn = (_cmd, args) => {
			seenArgs.push(args);
			if (args.includes('bun')) return { stdout: '1.3.13', stderr: '', exitCode: 0 };
			return { stdout: 'v20.11.1', stderr: '', exitCode: 0 };
		};

		assertContainerToolchain({
			containerName: 'my-cam-worker',
			execFn,
			bunVersionPath: BUN_PIN_PATH,
			toolVersionsPath: NODE_PIN_PATH,
			readFileFn,
		});

		expect(seenArgs).toEqual([
			['exec', 'my-cam-worker', 'bun', '--version'],
			['exec', 'my-cam-worker', 'node', '--version'],
		]);
	});
});
