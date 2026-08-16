import process from 'node:process';

import type { AgentProviderId } from './agent-session.ts';
import { CodexAppServer, type CodexLoginStart } from './codex-app-server.ts';
import { buildProviderAuthEnv } from './provider-env.ts';

export interface ProviderStatus {
	id: AgentProviderId;
	installed: boolean;
	subscription: boolean;
	label: string;
	plan?: string;
	login: 'external' | 'web';
}

export interface ProviderAuth {
	list(): Promise<ProviderStatus[]>;
	startCodexLogin(): Promise<CodexLoginStart>;
	close(): Promise<void>;
}

export type ProviderCommandRunner = (
	command: string[],
) => { exitCode: number; stdout: string; stderr: string };

function defaultRunner(command: string[]): ReturnType<ProviderCommandRunner> {
	try {
		const result = Bun.spawnSync(command, {
			env: buildProviderAuthEnv(process.env),
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return {
			exitCode: result.exitCode,
			stdout: new TextDecoder().decode(result.stdout),
			stderr: new TextDecoder().decode(result.stderr),
		};
	} catch (error) {
		return { exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
	}
}

function claudeStatus(run: ProviderCommandRunner): ProviderStatus {
	const result = run(['claude', 'auth', 'status', '--json']);
	if (result.exitCode !== 0) {
		return { id: 'claude', installed: !result.stderr.includes('ENOENT'), subscription: false, label: 'Claude Code', login: 'external' };
	}
	let status: Record<string, unknown> = {};
	try {
		status = JSON.parse(result.stdout) as Record<string, unknown>;
	} catch {
		return { id: 'claude', installed: true, subscription: false, label: 'Claude Code', login: 'external' };
	}
	const subscription = status['loggedIn'] === true && status['authMethod'] === 'claude.ai';
	const plan = typeof status['subscriptionType'] === 'string' ? status['subscriptionType'] : undefined;
	return {
		id: 'claude',
		installed: true,
		subscription,
		label: 'Claude Code',
		login: 'external',
		...(plan === undefined ? {} : { plan }),
	};
}

function codexStatusFromAccount(accountValue: unknown): ProviderStatus {
	const response = accountValue !== null && typeof accountValue === 'object'
		? accountValue as Record<string, unknown>
		: {};
	const account = response['account'] !== null && typeof response['account'] === 'object'
		? response['account'] as Record<string, unknown>
		: null;
	const subscription = account?.['type'] === 'chatgpt';
	const plan = typeof account?.['planType'] === 'string' ? account['planType'] : undefined;
	return {
		id: 'codex',
		installed: true,
		subscription,
		label: 'Codex',
		login: 'web',
		...(plan === undefined ? {} : { plan }),
	};
}

export class NativeProviderAuth implements ProviderAuth {
	readonly #run: ProviderCommandRunner;
	readonly #codex: CodexAppServer;

	constructor(options: { run?: ProviderCommandRunner; codex?: CodexAppServer } = {}) {
		this.#run = options.run ?? defaultRunner;
		this.#codex = options.codex ?? new CodexAppServer();
	}

	async list(): Promise<ProviderStatus[]> {
		const claude = claudeStatus(this.#run);
		let codex: ProviderStatus;
		try {
			codex = codexStatusFromAccount(await this.#codex.readAccount());
		} catch {
			const installed = this.#run(['codex', '--version']).exitCode === 0;
			codex = { id: 'codex', installed, subscription: false, label: 'Codex', login: 'web' };
		}
		return [claude, codex];
	}

	startCodexLogin(): Promise<CodexLoginStart> {
		return this.#codex.startChatGptLogin();
	}

	close(): Promise<void> {
		return this.#codex.close();
	}
}
