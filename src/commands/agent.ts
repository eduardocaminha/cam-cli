import process from 'node:process';

import { fingerprintSpec, type Spec } from '../issues/spec.ts';

export const AGENT_API_VERSION = 'v1';
export const DEFAULT_AGENT_URL = 'http://127.0.0.1:7777';
export const AGENT_MAX_LIST_LIMIT = 100;
export const AGENT_DEFAULT_LIST_LIMIT = 20;
export const AGENT_DEFAULT_PAGE_MAX_OUTPUT_BYTES = 12 * 1024;
export const AGENT_MAX_OUTPUT_BYTES = 64 * 1024;

interface AgentOperation {
	readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
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

const projectRootPath = (input: Record<string, unknown>) =>
	`/api/projects/${encodeURIComponent(requiredString(input, 'projectId'))}`;
const projectPath = (suffix: string) => (input: Record<string, unknown>) =>
	`${projectRootPath(input)}${suffix}`;
const issuePath = (suffix = '') => (input: Record<string, unknown>) =>
	`${projectRootPath(input)}/issues/${encodeURIComponent(requiredString(input, 'issueId'))}${suffix}`;
const runPath = (suffix: string) => (input: Record<string, unknown>) =>
	`${projectRootPath(input)}/runs/${encodeURIComponent(requiredString(input, 'runId'))}${suffix}`;

export const AGENT_OPERATIONS: Readonly<Record<string, AgentOperation>> = {
	'project.inspect': { method: 'GET', path: () => '/api/project', input: '{}' },
	'projects.list': { method: 'GET', path: () => '/api/projects', input: '{}', listField: 'projects' },
	'projects.status': { method: 'GET', path: projectPath('/status'), input: '{projectId}' },
	'projects.register': { method: 'POST', path: () => '/api/projects', input: '{root}' },
	'projects.unregister': { method: 'DELETE', path: projectRootPath, input: '{projectId}' },
	'status.get': { method: 'GET', path: projectPath('/snapshot'), input: '{projectId}' },
	'backlog.list': { method: 'GET', path: projectPath('/backlog'), input: '{projectId, limit?, offset?}' },
	'issues.list': { method: 'GET', path: projectPath('/issues'), input: '{projectId, limit?, offset?}', listField: 'issues' },
	'issues.get': { method: 'GET', path: issuePath(), input: '{projectId, issueId}' },
	'runs.list': { method: 'GET', path: projectPath('/runs'), input: '{projectId, limit?, offset?}', listField: 'runs' },
	'runs.get': { method: 'GET', path: runPath(''), input: '{projectId, runId}' },
	'runs.events': { method: 'GET', path: runPath('/events'), input: '{projectId, runId, limit?, offset?}', listField: 'events' },
	'issues.create': { method: 'POST', path: projectPath('/issues'), input: '{projectId, title, scope, verificationCommand, evidence?}' },
	'issues.specify': { method: 'POST', path: issuePath('/spec'), input: '{projectId, issueId, scope, verificationCommand, evidence?}' },
	'issues.approve': { method: 'POST', path: issuePath('/approve'), input: '{projectId, issueId, fingerprint, authorization}' },
	'issues.abandon': { method: 'POST', path: issuePath('/abandon'), input: '{projectId, issueId, reason}' },
	'brief.get': { method: 'GET', path: projectPath('/brief'), input: '{projectId}' },
	'brief.update': { method: 'PUT', path: projectPath('/brief'), input: '{projectId, objective, decisions, constraints, openItems, authorization}' },
	'runs.start': { method: 'POST', path: projectPath('/runs'), input: '{projectId, issueId}' },
	'runs.respond': { method: 'POST', path: runPath('/resume'), input: '{projectId, runId, message}' },
	'runs.cancel': { method: 'POST', path: runPath('/cancel'), input: '{projectId, runId}' },
	'runs.abandon': { method: 'POST', path: runPath('/abandon'), input: '{projectId, runId}' },
	'runs.ship': { method: 'POST', path: runPath('/ship'), input: '{projectId, runId}' },
};

const GUIDE = [
	'Use gship agent as the source of truth for Gateship state and actions.',
	'Use issues.list and runs.list for discovery, then issues.get or runs.get for detail.',
	'Use projects.list to select a projectId, then pass it to every project lifecycle operation.',
	'Use projects.register with an absolute root to add a checkout that already exists on disk.',
	'Use projects.unregister to drop a registration; it deletes no file and no project history.',
	'Before acting, call status.get and read the relevant issue or run in detail.',
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

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown> : {};
}

function shortString(value: unknown, limit: number): string | null {
	if (typeof value !== 'string') return null;
	const encodedBytes = (candidate: string) => Buffer.byteLength(JSON.stringify(candidate)) - 2;
	if (encodedBytes(value) <= limit) return value;
	let shortened = '';
	for (const character of value) {
		if (encodedBytes(`${shortened}${character}…`) > limit) break;
		shortened += character;
	}
	return `${shortened}…`;
}

function issueListItem(value: unknown): Record<string, unknown> {
	const issue = record(value);
	const spec = record(issue['spec']);
	const approval = record(issue['approval']);
	const approved = typeof approval['fingerprint'] === 'string'
		&& typeof spec['scope'] === 'string'
		&& approval['fingerprint'] === fingerprintSpec(spec as unknown as Spec);
	return {
		id: shortString(issue['id'], 48),
		title: shortString(issue['title'], 96),
		stage: shortString(issue['stage'], 16),
		status: shortString(issue['status'], 16),
		blockedBy: Array.isArray(issue['blockedBy'])
			? issue['blockedBy'].filter((id): id is string => typeof id === 'string')
			: [],
		updatedAt: shortString(issue['updatedAt'], 48),
		approved,
	};
}

function runListItem(value: unknown): Record<string, unknown> {
	const run = record(value);
	const pullRequest = record(run['pullRequest']);
	return {
		id: shortString(run['id'], 40),
		issueId: shortString(run['issueId'], 40),
		state: shortString(run['state'], 24),
		providerId: shortString(run['providerId'], 24),
		fixRounds: typeof run['fixRounds'] === 'number' ? run['fixRounds'] : 0,
		updatedAt: shortString(run['updatedAt'], 40),
		summary: shortString(run['summary'], 64),
		pullRequest: {
			url: shortString(pullRequest['url'], 80),
			ciStatus: shortString(pullRequest['ciStatus'], 24),
		},
	};
}

const ACTIVE_RUN_STATES = new Set([
	'queued', 'working', 'verify', 'review', 'full-verify', 'ready-to-ship', 'shipping',
	'waiting-user', 'waiting-provider', 'interrupted',
]);
const RUN_ATTENTION_STATES = new Set([
	'ready-to-ship', 'waiting-user', 'waiting-provider', 'failed', 'interrupted',
]);

function attentionRequests(snapshot: Record<string, unknown>, latestRun: Record<string, unknown> | null): unknown[] {
	const requests: unknown[] = [];
	if (latestRun !== null && RUN_ATTENTION_STATES.has(String(latestRun['state']))) {
		requests.push({
			kind: 'run',
			runId: latestRun['id'],
			state: latestRun['state'],
			summary: latestRun['summary'],
		});
	}
	for (const value of Array.isArray(snapshot['workspaceNotices']) ? snapshot['workspaceNotices'].slice(0, 10) : []) {
		const notice = record(value);
		requests.push({
			kind: shortString(notice['kind'], 32),
			runId: shortString(notice['runId'], 64),
			detail: shortString(notice['detail'], 240),
		});
	}
	for (const key of ['staleService', 'gitIdentity'] as const) {
		if (snapshot[key] === undefined) continue;
		requests.push({ kind: key, detail: shortString(record(snapshot[key])['detail'], 240) });
	}
	return requests;
}

function statusResult(snapshotValue: unknown, runsValue: unknown): Record<string, unknown> {
	const snapshot = record(snapshotValue);
	const backlog = record(record(snapshot['idleState'])['backlog']);
	const sourceCounts = record(backlog['counts']);
	const runs = Array.isArray(record(runsValue)['runs']) ? record(runsValue)['runs'] as unknown[] : [];
	const projectedRuns = runs.map(runListItem);
	const latest = projectedRuns[0] ?? null;
	const active = projectedRuns.find((run) => ACTIVE_RUN_STATES.has(String(run['state']))) ?? null;
	return {
		version: shortString(snapshot['version'], 120),
		backlog: {
			counts: Object.fromEntries(['idea', 'specified', 'planned', 'shipped']
				.filter((stage) => typeof sourceCounts[stage] === 'number')
				.map((stage) => [stage, sourceCounts[stage]])),
			plannable: (Array.isArray(backlog['plannable']) ? backlog['plannable'] : []).slice(0, AGENT_DEFAULT_LIST_LIMIT)
				.map((value) => {
					const issue = record(value);
					return { id: shortString(issue['id'], 64), title: shortString(issue['title'], 160) };
				}),
		},
		activeRun: active,
		attentionRequests: attentionRequests(snapshot, latest),
	};
}

function projectResult(operation: string, value: unknown): Record<string, unknown> {
	const result = record(value);
	if (operation === 'issues.list') {
		return {
			issues: (Array.isArray(result['issues']) ? result['issues'] : []).map(issueListItem),
			page: result['page'],
		};
	}
	if (operation === 'runs.list') {
		return {
			runs: (Array.isArray(result['runs']) ? result['runs'] : []).map(runListItem),
			page: result['page'],
		};
	}
	return result;
}

function pageOperationResult(
	operation: AgentOperation,
	result: Record<string, unknown>,
	input: Record<string, unknown>,
): Record<string, unknown> {
	if (operation.listField === undefined) return result;
	const paged = page(result[operation.listField], input);
	return { ...result, [operation.listField]: paged.items, page: paged.page };
}

function clamp(value: unknown, depth = 0): unknown {
	if (typeof value === 'string') return value.length <= 2_000 ? value : `${value.slice(0, 2_000)}…`;
	if (value === null || typeof value !== 'object') return value;
	if (depth >= 8) return '[truncated]';
	if (Array.isArray(value)) return value.map((item) => clamp(item, depth + 1));
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.slice(0, 100)
		.map(([key, item]) => [key, clamp(item, depth + 1)]));
}

function outputObject(
	value: unknown,
	maxBytes = AGENT_MAX_OUTPUT_BYTES,
	shouldClamp = true,
): Record<string, unknown> {
	const limited = shouldClamp ? clamp(value) : value;
	const object = limited !== null && typeof limited === 'object' && !Array.isArray(limited)
		? limited as Record<string, unknown>
		: { ok: true, result: limited };
	const encoded = JSON.stringify(object);
	if (Buffer.byteLength(encoded) <= maxBytes) return object;
	return {
		ok: false,
		code: 'output-too-large',
		message: maxBytes === AGENT_DEFAULT_PAGE_MAX_OUTPUT_BYTES
			? `Response exceeds ${maxBytes} bytes; retry issues.list with a smaller explicit "limit".`
			: `Response exceeds ${maxBytes} bytes; request a smaller page.`,
	};
}

function hasExplicitListLimit(input: Record<string, unknown>): boolean {
	return Number.isSafeInteger(input['limit']) && Number(input['limit']) > 0;
}

function operationOutput(
	operation: string,
	input: Record<string, unknown>,
	value: Record<string, unknown>,
): Record<string, unknown> {
	if (operation !== 'issues.list') return outputObject(value);
	const maxBytes = hasExplicitListLimit(input)
		? AGENT_MAX_OUTPUT_BYTES : AGENT_DEFAULT_PAGE_MAX_OUTPUT_BYTES;
	return outputObject(value, maxBytes, false);
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

/**
 * The JSON an operation sends, or nothing at all. A read and a removal both
 * name their whole target in the path, so neither carries a body.
 */
function requestBodyJson(
	operation: AgentOperation,
	name: string,
	input: Record<string, unknown>,
): string | undefined {
	if (operation.method === 'GET' || operation.method === 'DELETE') return undefined;
	return JSON.stringify(requestBody(name, input));
}

function requestBody(operation: string, input: Record<string, unknown>): Record<string, unknown> {
	const { projectId: _projectId, ...projectInput } = input;
	if (operation === 'brief.update') {
		const { authorization: _authorization, ...brief } = projectInput;
		return brief;
	}
	return projectInput;
}

export interface AgentExecutionResult {
	exitCode: number;
	output: Record<string, unknown>;
}

export type AgentFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function completedOutput(output: Record<string, unknown>): AgentExecutionResult {
	return { exitCode: output['ok'] === false ? 1 : 0, output };
}

async function readJsonResponse(
	url: string,
	init: RequestInit,
	serviceUrl: string,
	fetchFn: AgentFetch,
): Promise<{ response: Response; payload: unknown }> {
	let response: Response;
	try {
		response = await fetchFn(url, init);
	} catch {
		throw new AgentCliError('service-unavailable', `Gateship is unavailable at ${serviceUrl}.`);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new AgentCliError('invalid-response', `Gateship returned a non-JSON response (HTTP ${response.status}).`);
	}
	return { response, payload };
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
		const body = requestBodyJson(operation, operationName, parsed.input);
		if (body !== undefined) headers['content-type'] = 'application/json';
		const { response, payload } = await readJsonResponse(
			`${parsed.url}${operation.path(parsed.input)}`,
			{ method: operation.method, headers, body },
			parsed.url,
			fetchFn,
		);
		if (!response.ok) {
			return { exitCode: 1, output: httpError(payload, response.status) };
		}
		let result = pageOperationResult(operation, payload as Record<string, unknown>, parsed.input);
		result = projectResult(operationName, result);
		if (operationName === 'status.get') {
			const { response: runsResponse, payload: runsPayload } = await readJsonResponse(
				`${parsed.url}${projectPath('/runs')(parsed.input)}`,
				{ method: 'GET', headers },
				parsed.url,
				fetchFn,
			);
			if (!runsResponse.ok) return { exitCode: 1, output: httpError(runsPayload, runsResponse.status) };
			result = statusResult(result, runsPayload);
		}
		const output = operationOutput(
			operationName,
			parsed.input,
			{ ok: true, version: AGENT_API_VERSION, operation: operationName, result },
		);
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
