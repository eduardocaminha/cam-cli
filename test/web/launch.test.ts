// test/web/launch.test.ts
//
// Real-process coverage for the `bun index.ts web` launch boundary: resolved
// localhost bind, both --port spellings, CLI-only port validation, occupied
// port diagnostics, and signal-to-exit-code shutdown.

import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { startWebServer } from '../../src/commands/web.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const INDEX_TS = join(REPO_ROOT, 'index.ts');
const liveProcesses = new Set<ReturnType<typeof Bun.spawn>>();

interface SpawnedWebCli {
	proc: ReturnType<typeof Bun.spawn>;
	readyUrl: Promise<string>;
	stdoutText: Promise<string>;
	stderrText: Promise<string>;
}

async function collectTextUntilClose(
	stream: ReadableStream<Uint8Array>,
	onText: (text: string) => void,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = '';
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		text += decoder.decode(chunk.value, { stream: true });
		onText(text);
	}
	text += decoder.decode();
	onText(text);
	return text;
}

function spawnWebCli(args: string[]): SpawnedWebCli {
	const proc = Bun.spawn(['bun', INDEX_TS, 'web', ...args], {
		cwd: REPO_ROOT,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	liveProcesses.add(proc);

	let resolveReady!: (url: string) => void;
	let rejectReady!: (error: Error) => void;
	let settled = false;
	const readyUrl = new Promise<string>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const stdoutText = collectTextUntilClose(proc.stdout, (text) => {
		const firstLine = text.split('\n')[0]?.trim();
		if (!settled && firstLine?.startsWith('http://')) {
			settled = true;
			resolveReady(firstLine);
		}
	}).then((text) => {
		if (!settled) {
			settled = true;
			rejectReady(new Error(`web CLI exited before printing its URL: ${JSON.stringify(text)}`));
		}
		return text;
	});
	const stderrText = new Response(proc.stderr).text();
	return { proc, readyUrl, stdoutText, stderrText };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function launchAndTerminate(args: string[]): Promise<{
	url: string;
	exitCode: number;
	stdout: string;
	stderr: string;
}> {
	const launched = spawnWebCli(args);
	const url = await withTimeout(launched.readyUrl);
	const response = await fetch(url);
	expect(response.status).toBe(200);
	launched.proc.kill('SIGTERM');
	const [exitCode, stdout, stderr] = await Promise.all([
		launched.proc.exited,
		launched.stdoutText,
		launched.stderrText,
	]);
	liveProcesses.delete(launched.proc);
	return { url, exitCode, stdout, stderr };
}

afterEach(async () => {
	for (const proc of liveProcesses) {
		proc.kill('SIGKILL');
		await proc.exited;
	}
	liveProcesses.clear();
});

describe('web server launch', () => {
	test('startWebServer supports an ephemeral port and reports the resolved localhost address', async () => {
		const handle = startWebServer({ port: 0, cwd: REPO_ROOT });
		try {
			expect(handle.port).toBeGreaterThan(0);
			expect(handle.hostname).toBe('127.0.0.1');
			const response = await fetch(`http://${handle.hostname}:${handle.port}/`);
			expect(await response.text()).toBe('Gateship web\n');
		} finally {
			await handle.stop();
		}
	});

	test('bun index.ts web binds the default 127.0.0.1:7777 and exits 143 on SIGTERM', async () => {
		const result = await launchAndTerminate([]);
		expect(result.url).toBe('http://127.0.0.1:7777');
		expect(result.stdout).toContain('http://127.0.0.1:7777');
		expect(result.stderr).toBe('');
		expect(result.exitCode).toBe(143);
	}, 10_000);

	test('the CLI accepts both --port N and --port=N', async () => {
		for (const joined of [false, true]) {
			const reservation = startWebServer({ port: 0, cwd: REPO_ROOT });
			const port = reservation.port;
			await reservation.stop();

			const result = await launchAndTerminate(joined ? [`--port=${port}`] : ['--port', String(port)]);
			expect(result.url).toBe(`http://127.0.0.1:${port}`);
			expect(result.exitCode).toBe(143);
		}
	}, 15_000);

	test.each(['0', '-1', 'NaN', 'Infinity'])(
		'rejects invalid CLI --port value %s with a named diagnostic',
		(value) => {
			const result = Bun.spawnSync(['bun', INDEX_TS, 'web', '--port', value], {
				cwd: REPO_ROOT,
				stdout: 'pipe',
				stderr: 'pipe',
			});
			expect(result.exitCode).not.toBe(0);
			expect(new TextDecoder().decode(result.stderr)).toContain('--port');
		},
	);

	test('an occupied port fails nonzero with a --port diagnostic', async () => {
		const occupied = startWebServer({ port: 0, cwd: REPO_ROOT });
		try {
			const result = Bun.spawnSync(['bun', INDEX_TS, 'web', `--port=${occupied.port}`], {
				cwd: REPO_ROOT,
				stdout: 'pipe',
				stderr: 'pipe',
			});
			expect(result.exitCode).not.toBe(0);
			expect(new TextDecoder().decode(result.stderr)).toContain('--port');
		} finally {
			await occupied.stop();
		}
	});
});
