// test/web/launch.test.ts
//
// Real-process coverage for the `bun index.ts` launch boundary: resolved
// localhost bind, both --port spellings, CLI-only port validation, occupied
// port diagnostics, and signal-to-exit-code shutdown.
//
// The launched processes bind explicit ephemeral ports so the suite coexists
// with the live Gateship on 127.0.0.1:7777. The default port itself is asserted
// through parseWebArgs/DEFAULT_WEB_PORT, without opening a socket.

import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { parseWebArgs } from '../../index.ts';
import {
	BIND_HOSTNAME_ENV_VAR,
	DEFAULT_WEB_PORT,
	isTrustedCommandOrigin,
	resolveBindHostname,
	startWebServer,
	WEB_HOSTNAME,
} from '../../src/commands/web.ts';
import { createTestTmpdir } from '../helpers/test-tmpdir.ts';

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

/** Binds and releases an ephemeral port so the CLI can be given it explicitly. */
function reserveEphemeralPort(): number {
	const server = Bun.serve({ hostname: WEB_HOSTNAME, port: 0, fetch: () => new Response('') });
	const { port } = server;
	server.stop(true);
	if (port === undefined) throw new Error('Bun.serve did not report an ephemeral port');
	return port;
}

function spawnWebCli(args: string[]): SpawnedWebCli {
	const proc = Bun.spawn(['bun', INDEX_TS, ...args], {
		cwd: createTestTmpdir('gship-web-cli-'),
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
		const handle = startWebServer({ port: 0, cwd: createTestTmpdir('gship-web-launch-') });
		try {
			expect(handle.port).toBeGreaterThan(0);
			expect(handle.hostname).toBe('127.0.0.1');
			const response = await fetch(`http://${handle.hostname}:${handle.port}/`);
			expect(response.headers.get('content-type')).toContain('text/html');
			expect(await response.text()).toContain('<title>Gateship</title>');
		} finally {
			await handle.stop();
		}
	});

	test('the CLI default port is 7777 and needs no socket to resolve', () => {
		expect(DEFAULT_WEB_PORT).toBe(7777);
		expect(parseWebArgs([])).toEqual({ port: DEFAULT_WEB_PORT, help: false });
	});

	test('bun index.ts binds the requested port and exits 143 on SIGTERM', async () => {
		const port = reserveEphemeralPort();
		const result = await launchAndTerminate([`--port=${port}`]);
		expect(result.url).toBe(`http://127.0.0.1:${port}`);
		expect(result.stdout).toContain(`http://127.0.0.1:${port}`);
		expect(result.stderr).toBe('');
		expect(result.exitCode).toBe(143);
	}, 10_000);

	// The default entry takes no options, so its target is always DEFAULT_WEB_PORT
	// and it is read from whichever channel the process reports it on: the printed
	// URL when the port is free, or the bind diagnostic when a Gateship owns it.
	test('bun index.ts with no subcommand targets the default web server', async () => {
		const launched = spawnWebCli([]);
		let url: string | null = null;
		try {
			url = await withTimeout(launched.readyUrl);
		} catch {
			url = null;
		}
		if (url !== null) launched.proc.kill('SIGTERM');
		const [exitCode, stderr] = await Promise.all([launched.proc.exited, launched.stderrText]);
		liveProcesses.delete(launched.proc);

		if (url !== null) {
			expect(url).toBe(`http://${WEB_HOSTNAME}:${DEFAULT_WEB_PORT}`);
			expect(stderr).toBe('');
			expect(exitCode).toBe(143);
			return;
		}
		expect(stderr).toContain(`failed to bind --port ${DEFAULT_WEB_PORT} on ${WEB_HOSTNAME}`);
		expect(exitCode).toBe(1);
	}, 10_000);

	test('the CLI accepts both --port N and --port=N', async () => {
		for (const joined of [false, true]) {
			const port = reserveEphemeralPort();
			const result = await launchAndTerminate(joined ? [`--port=${port}`] : ['--port', String(port)]);
			expect(result.url).toBe(`http://127.0.0.1:${port}`);
			expect(result.exitCode).toBe(143);
		}
	}, 15_000);

	test.each(['0', '-1', 'NaN', 'Infinity'])(
		'rejects invalid CLI --port value %s with a named diagnostic',
		(value) => {
			const result = Bun.spawnSync(['bun', INDEX_TS, '--port', value], {
				cwd: createTestTmpdir('gship-web-invalid-port-'),
				stdout: 'pipe',
				stderr: 'pipe',
			});
			expect(result.exitCode).not.toBe(0);
			expect(new TextDecoder().decode(result.stderr)).toContain('--port');
		},
	);

	test('an occupied port fails nonzero with a --port diagnostic', async () => {
		const cwd = createTestTmpdir('gship-web-occupied-');
		const occupied = startWebServer({ port: 0, cwd });
		try {
			const result = Bun.spawnSync(['bun', INDEX_TS, `--port=${occupied.port}`], {
				cwd,
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

describe('GATESHIP_BIND_HOST (container bind address)', () => {
	test('resolveBindHostname keeps WEB_HOSTNAME when unset or blank', () => {
		expect(resolveBindHostname({})).toBe(WEB_HOSTNAME);
		expect(resolveBindHostname({ [BIND_HOSTNAME_ENV_VAR]: '' })).toBe(WEB_HOSTNAME);
		expect(resolveBindHostname({ [BIND_HOSTNAME_ENV_VAR]: '   ' })).toBe(WEB_HOSTNAME);
	});

	test('resolveBindHostname trims and returns an explicit override', () => {
		expect(resolveBindHostname({ [BIND_HOSTNAME_ENV_VAR]: '0.0.0.0' })).toBe('0.0.0.0');
		expect(resolveBindHostname({ [BIND_HOSTNAME_ENV_VAR]: '  0.0.0.0  ' })).toBe('0.0.0.0');
	});

	// A container must bind a non-loopback interface, or Docker's
	// published-port proxy -- which always connects to the container's own
	// network address, never its loopback -- has nothing to reach.
	test('startWebServer binds the overridden host, not WEB_HOSTNAME', async () => {
		const previous = process.env[BIND_HOSTNAME_ENV_VAR];
		process.env[BIND_HOSTNAME_ENV_VAR] = '0.0.0.0';
		const handle = startWebServer({ port: 0, cwd: createTestTmpdir('gship-web-bind-host-') });
		try {
			expect(handle.hostname).not.toBe(WEB_HOSTNAME);
			const response = await fetch(`http://127.0.0.1:${handle.port}/`);
			expect(response.status).toBe(200);
		} finally {
			await handle.stop();
			if (previous === undefined) delete process.env[BIND_HOSTNAME_ENV_VAR];
			else process.env[BIND_HOSTNAME_ENV_VAR] = previous;
		}
	});

	// The bind address is a socket concern only: the browser always reaches
	// the service through 127.0.0.1 or localhost (the host side of a
	// container's published port stays restricted to loopback), so the
	// trusted-origin check must keep accepting exactly those regardless of
	// what the process bound to.
	test('the trusted-origin check is unaffected by the bind host override', () => {
		const trusted = new Request('http://127.0.0.1:7777/api/runs', {
			headers: { origin: 'http://127.0.0.1:7777' },
		});
		expect(isTrustedCommandOrigin(trusted)).toBe(true);
	});
});
