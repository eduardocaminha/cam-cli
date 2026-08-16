import { GSHIP_VERSION } from '../version.ts';
import { buildProviderAuthEnv } from './provider-env.ts';

type AppServerChild = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

interface RpcResponse {
	id?: unknown;
	result?: unknown;
	error?: unknown;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export interface CodexLoginStart {
	loginId: string;
	authUrl: string;
}

export interface CodexAppServerOptions {
	command?: string[];
}

function errorMessage(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		const message = (value as Record<string, unknown>)['message'];
		if (typeof message === 'string') return message;
	}
	return JSON.stringify(value);
}

/** Small JSONL client for the stable account surface of `codex app-server`. */
export class CodexAppServer {
	readonly #command: string[];
	readonly #pending = new Map<number, PendingRequest>();
	#child: AppServerChild | undefined;
	#reader: Promise<void> | undefined;
	#nextId = 1;
	#initialized: Promise<void> | undefined;

	constructor(options: CodexAppServerOptions = {}) {
		this.#command = options.command ?? ['codex', 'app-server', '--stdio'];
	}

	async readAccount(): Promise<unknown> {
		await this.#initialize();
		return this.#request('account/read', { refreshToken: false });
	}

	async startChatGptLogin(): Promise<CodexLoginStart> {
		await this.#initialize();
		const value = await this.#request('account/login/start', {
			type: 'chatgpt',
			useHostedLoginSuccessPage: true,
			appBrand: 'codex',
		});
		const result = value !== null && typeof value === 'object'
			? value as Record<string, unknown>
			: {};
		if (result['type'] !== 'chatgpt'
			|| typeof result['loginId'] !== 'string'
			|| typeof result['authUrl'] !== 'string') {
			throw new Error('Codex app-server returned an invalid login response.');
		}
		return { loginId: result['loginId'], authUrl: result['authUrl'] };
	}

	async close(): Promise<void> {
		const child = this.#child;
		if (child === undefined) return;
		this.#child = undefined;
		child.kill('SIGTERM');
		await child.exited;
		await this.#reader?.catch(() => {});
		this.#reader = undefined;
		this.#initialized = undefined;
	}

	async #initialize(): Promise<void> {
		if (this.#initialized !== undefined) return this.#initialized;
		this.#initialized = this.#startAndInitialize();
		try {
			await this.#initialized;
		} catch (error) {
			this.#initialized = undefined;
			throw error;
		}
	}

	async #startAndInitialize(): Promise<void> {
		const child = Bun.spawn({
			cmd: this.#command,
			env: buildProviderAuthEnv(process.env),
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		this.#child = child;
		this.#reader = this.#consume(child);
		await this.#request('initialize', {
			clientInfo: { name: 'gateship', title: 'Gateship', version: GSHIP_VERSION },
		});
		this.#send({ method: 'initialized', params: {} });
	}

	#request(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = this.#nextId;
		this.#nextId += 1;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#send({ method, id, params });
		});
	}

	#send(message: Record<string, unknown>): void {
		const child = this.#child;
		if (child === undefined) throw new Error('Codex app-server is not running.');
		child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	async #consume(child: AppServerChild): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = '';
		for await (const chunk of child.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf('\n');
			while (newline >= 0) {
				this.#consumeLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf('\n');
			}
		}
		buffer += decoder.decode();
		if (buffer.length > 0) this.#consumeLine(buffer);
		const stderr = await new Response(child.stderr).text();
		const message = stderr.trim() || `Codex app-server exited with ${await child.exited}.`;
		for (const pending of this.#pending.values()) pending.reject(new Error(message));
		this.#pending.clear();
	}

	#consumeLine(line: string): void {
		let message: RpcResponse;
		try {
			message = JSON.parse(line) as RpcResponse;
		} catch {
			return;
		}
		if (typeof message.id !== 'number') return;
		const pending = this.#pending.get(message.id);
		if (pending === undefined) return;
		this.#pending.delete(message.id);
		if (message.error !== undefined) {
			pending.reject(new Error(errorMessage(message.error)));
			return;
		}
		pending.resolve(message.result);
	}
}
