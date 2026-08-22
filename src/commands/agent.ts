import process from 'node:process';

export const AGENT_API_VERSION = 'v1';
export const DEFAULT_AGENT_URL = 'http://127.0.0.1:7777';
export const AGENT_MAX_LIST_LIMIT = 100;
export const AGENT_DEFAULT_LIST_LIMIT = 20;
export const AGENT_MAX_OUTPUT_BYTES = 64 * 1024;

interface AgentOperation {
	readonly method: 'GET' | 'POST' | 'PUT';
	readonly path: (input: Record<string, unknown>) => string;
	readonly input: string;
	readonly listField?: string;
}

const requiredString = (input: Record<string, unknown>, field: string): string => {
	const value = input[field];
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new AgentCliError('invalid-input', `"${field}" must be a non-empty string.`);
	}
	return value.trim();
};

const issuePath = (suffix = '') => (input: Record<string, unknown>) =>
	`/api/issues/${encodeURIComponent(requiredString(input, 'issueId'))}${suffix}`;
const runPath = (suffix: string) => (input: Record<string, unknown>) =>
	`/api/runs/${encodeURIComponent(requiredString(input, 'runId'))}${suffix}`;

export const AGENT_OPERATIONS: Readonly<Record<string, AgentOperation>> = {
	'project.inspect': { method: 'GET', path: () => '/api/project', input: '{}' },
	'status.get': { method: 'GET', path: () => '/api/snapshot', input: '{}' },
	'backlog.list': { method: 'GET', path: () => '/api/backlog', input: '{limit?, offset?}' },
	'issues.list': { method: 'GET', path: () => '/api/issues', input: '{limit?, offset?}', listField: 'issues' },
	'issues.get': { method: 'GET', path: issuePath(), input: '{issueId}' },
	'runs.list': { method: 'GET', path: () => '/api/runs', input: '{limit?, offset?}', listField: 'runs' },
	'runs.events': { method: 'GET', path: runPath('/events'), input: '{runId, limit?, offset?}', listField: 'events' },
	'issues.create': { method: 'POST', path: () => '/api/issues', input: '{title, scope, verificationCommand, evidence?}' },
	'issues.specify': { method: 'POST', path: issuePath('/spec'), input: '{issueId, scope, verificationCommand, evidence?}' },
	'issues.approve': { method: 'POST', path: issuePath('/approve'), input: '{issueId, fingerprint, authorization}' },
	'issues.abandon': { method: 'POST', path: issuePath('/abandon'), input: '{issueId, reason}' },
	'brief.get': { method: 'GET', path: () => '/api/brief', input: '{}' },
	'brief.update': { method: 'PUT', path: () => '/api/brief', input: '{objective, decisions, constraints, openItems, authorization}' },
	'runs.start': { method: 'POST', path: () => '/api/runs', input: '{issueId}' },
	'runs.respond': { method: 'POST', path: runPath('/resume'), input: '{runId, message}' },
	'runs.cancel': { method: 'POST', path: runPath('/cancel'), input: '{runId}' },
	'runs.abandon': { method: 'POST', path: runPath('/abandon'), input: '{runId}' },
	'runs.ship': { method: 'POST', path: runPath('/ship'), input: '{runId}' },
};

const GUIDE = [
	'Use gship agent as the source of truth for Gateship state and actions.',
	'Before acting, call status.get and read the relevant issue or run.',
	'Never edit .gship directly and never start another Gateship service.',
	'Never invent operator approval or authorization; pass only explicit operator text.',
	'Use `gship agent operations` for operation names and input formats.',
	'Call with `gship agent call <operation> --input <json>`.',
].join('\n');

class AgentCliError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
	}
}

export interface ParsedAgentArgs {
	command: 'guide' | 'operations' | 'call';
	operation?: string;
	input: Record<string, unknown>;
	url: string;
}

function agentCommand(value: string | undefined): ParsedAgentArgs['command'] {
	if (value === 'guide' || value === 'operations' || value === 'call') return value;
	throw new AgentCliError('invalid-command', 'Expected guide, operations, or call.');
}

function parseJsonInput(value: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new AgentCliError('invalid-json', '--input must be valid JSON.');
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new AgentCliError('invalid-json', '--input must be one JSON object.');
	}
	return parsed as Record<string, unknown>;
}

function optionAt(args: string[], index: number): { name: 'url' | 'input'; value: string; consumed: number } {
	const arg = args[index]!;
	if (arg === '--url' || arg === '--input') {
		const value = args[index + 1];
		if (value === undefined) throw new AgentCliError('invalid-command', `${arg} requires a value.`);
		return { name: arg === '--url' ? 'url' : 'input', value, consumed: 2 };
	}
	if (arg.startsWith('--url=')) return { name: 'url', value: arg.slice('--url='.length), consumed: 1 };
	if (arg.startsWith('--input=')) return { name: 'input', value: arg.slice('--input='.length), consumed: 1 };
	throw new AgentCliError('invalid-command', `Unknown agent option: ${arg}.`);
}

function localServiceUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AgentCliError('invalid-url', '--url must be an absolute local HTTP URL.');
	}
	if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
		|| url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0
		|| (url.pathname !== '/' && url.pathname !== '')) {
		throw new AgentCliError('invalid-url', '--url must target http://127.0.0.1 or http://localhost.');
	}
	return url.origin;
}

export function parseAgentArgs(args: string[]): ParsedAgentArgs {
	const command = agentCommand(args[0]);
	let operation: string | undefined;
	let input: Record<string, unknown> = {};
	let url = DEFAULT_AGENT_URL;
	let index = 1;
	if (command === 'call') {
		operation = args[index];
		if (operation === undefined || operation.startsWith('--')) {
			throw new AgentCliError('invalid-command', 'call requires an operation name.');
		}
		index += 1;
	}
	for (; index < args.length;) {
		const option = optionAt(args, index);
		if (option.name === 'url') url = localServiceUrl(option.value);
		else input = parseJsonInput(option.value);
		index += option.consumed;
	}
	return { command, ...(operation === undefined ? {} : { operation }), input, url };
}

function page(value: unknown, input: Record<string, unknown>): { items: unknown[]; page: Record<string, number> } {
	const items = Array.isArray(value) ? value : [];
	const rawLimit = input['limit'];
	const rawOffset = input['offset'];
	const limit = Number.isSafeInteger(rawLimit) && Number(rawLimit) > 0
		? Math.min(Number(rawLimit), AGENT_MAX_LIST_LIMIT) : AGENT_DEFAULT_LIST_LIMIT;
	const offset = Number.isSafeInteger(rawOffset) && Number(rawOffset) >= 0 ? Number(rawOffset) : 0;
	return {
		items: items.slice(offset, offset + limit),
		page: { offset, limit, returned: Math.min(limit, Math.max(0, items.length - offset)), total: items.length },
	};
}

function clamp(value: unknown, depth = 0): unknown {
	if (typeof value === 'string') return value.length <= 2_000 ? value : `${value.slice(0, 2_000)}…`;
	if (value === null || typeof value !== 'object') return value;
	if (depth >= 8) return '[truncated]';
	if (Array.isArray(value)) return value.slice(0, AGENT_MAX_LIST_LIMIT).map((item) => clamp(item, depth + 1));
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.slice(0, 100)
		.map(([key, item]) => [key, clamp(item, depth + 1)]));
}

function outputObject(value: unknown): Record<string, unknown> {
	const object = value !== null && typeof value === 'object' && !Array.isArray(value)
		? clamp(value) as Record<string, unknown>
		: { ok: true, result: clamp(value) };
	const encoded = JSON.stringify(object);
	if (Buffer.byteLength(encoded) <= AGENT_MAX_OUTPUT_BYTES) return object;
	return { ok: false, code: 'output-too-large', message: `Response exceeds ${AGENT_MAX_OUTPUT_BYTES} bytes; request a smaller page.` };
}

function httpError(payload: unknown, status: number): Record<string, unknown> {
	const error = outputObject(payload);
	return outputObject({
		...error,
		ok: false,
		code: typeof error['code'] === 'string' ? error['code'] : 'http-error',
		message: typeof error['message'] === 'string'
			? error['message'] : `Gateship refused the operation (HTTP ${status}).`,
		httpStatus: status,
	});
}

function requestBody(operation: string, input: Record<string, unknown>): Record<string, unknown> {
	if (operation === 'brief.update') {
		const { authorization: _authorization, ...brief } = input;
		return brief;
	}
	return input;
}

export interface AgentExecutionResult {
	exitCode: number;
	output: Record<string, unknown>;
}

export type AgentFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function completedOutput(output: Record<string, unknown>): AgentExecutionResult {
	return { exitCode: output['ok'] === false ? 1 : 0, output };
}

export async function executeAgent(
	args: string[],
	fetchFn: AgentFetch = fetch,
): Promise<AgentExecutionResult> {
	try {
		const parsed = parseAgentArgs(args);
		if (parsed.command === 'guide') {
			return { exitCode: 0, output: { ok: true, version: AGENT_API_VERSION, guide: GUIDE } };
		}
		if (parsed.command === 'operations') {
			return {
				exitCode: 0,
				output: {
					ok: true,
					version: AGENT_API_VERSION,
					operations: Object.entries(AGENT_OPERATIONS).map(([name, operation]) => ({ name, input: operation.input })),
				},
			};
		}
		const operationName = parsed.operation!;
		const operation = AGENT_OPERATIONS[operationName];
		if (operation === undefined) throw new AgentCliError('unknown-operation', `Unknown operation: ${operationName}.`);
		const headers: Record<string, string> = {
			accept: 'application/json',
			origin: parsed.url,
			'x-gateship-agent-version': AGENT_API_VERSION,
			'x-gateship-command-source': 'agent-cli',
		};
		if (operationName === 'brief.update') {
			headers['x-gateship-operator-authorization'] = requiredString(parsed.input, 'authorization');
		}
		const body = operation.method === 'GET' ? undefined : JSON.stringify(requestBody(operationName, parsed.input));
		if (body !== undefined) headers['content-type'] = 'application/json';
		let response: Response;
		try {
			response = await fetchFn(`${parsed.url}${operation.path(parsed.input)}`, { method: operation.method, headers, body });
		} catch {
			throw new AgentCliError('service-unavailable', `Gateship is unavailable at ${parsed.url}.`);
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new AgentCliError('invalid-response', `Gateship returned a non-JSON response (HTTP ${response.status}).`);
		}
		if (!response.ok) {
			return { exitCode: 1, output: httpError(payload, response.status) };
		}
		let result = payload as Record<string, unknown>;
		if (operation.listField !== undefined) {
			const paged = page(result[operation.listField], parsed.input);
			result = { ...result, [operation.listField]: paged.items, page: paged.page };
		}
		const output = outputObject({ ok: true, version: AGENT_API_VERSION, operation: operationName, result });
		return completedOutput(output);
	} catch (error) {
		const code = error instanceof AgentCliError ? error.code : 'agent-cli-failed';
		return {
			exitCode: 1,
			output: outputObject({ ok: false, code, message: error instanceof Error ? error.message : String(error) }),
		};
	}
}

export async function runAgent(args: string[]): Promise<number> {
	const result = await executeAgent(args);
	process.stdout.write(`${JSON.stringify(result.output)}\n`);
	return result.exitCode;
}
