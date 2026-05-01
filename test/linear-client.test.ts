// test/linear-client.test.ts
//
// Unit tests for the Linear GraphQL client. We mock global `fetch` rather
// than hitting the real API — the contract we care about is:
//   - request has correct endpoint, method, auth header, body shape
//   - response parsing handles data / errors / missing-data shapes
//   - LinearApiError is thrown on HTTP failures and GraphQL errors
//
// The real network test lives separately (env-gated) and is not run in CI.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { LinearApiError, LinearClient } from '../src/linear/client.ts';

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

type FetchCall = { url: string; init: RequestInit };
let fetchCalls: FetchCall[] = [];
let fetchResponses: Array<() => Promise<Response>> = [];
const originalFetch = globalThis.fetch;

function enqueueJsonResponse(body: unknown, status = 200): void {
	fetchResponses.push(
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { 'Content-Type': 'application/json' },
			}),
	);
}

function enqueueTextResponse(body: string, status = 500): void {
	fetchResponses.push(
		async () => new Response(body, { status, headers: { 'Content-Type': 'text/plain' } }),
	);
}

beforeEach(() => {
	fetchCalls = [];
	fetchResponses = [];
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		fetchCalls.push({ url: String(url), init: init ?? {} });
		const next = fetchResponses.shift();
		if (!next) throw new Error('test bug: no response enqueued');
		return next();
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('LinearClient constructor', () => {
	it('throws LinearApiError when no API key is available', () => {
		const prev = process.env['LINEAR_API_KEY'];
		delete process.env['LINEAR_API_KEY'];
		try {
			expect(() => new LinearClient()).toThrow(LinearApiError);
		} finally {
			if (prev !== undefined) process.env['LINEAR_API_KEY'] = prev;
		}
	});

	it('accepts an explicit apiKey option over the env', () => {
		const c = new LinearClient({ apiKey: 'lin_test_123' });
		expect(c).toBeInstanceOf(LinearClient);
	});
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe('LinearClient request shape', () => {
	it('posts JSON to api.linear.app/graphql with the Authorization header (no Bearer prefix)', async () => {
		enqueueJsonResponse({ data: { viewer: { id: 'u1' } } });
		const c = new LinearClient({ apiKey: 'lin_xyz' });
		await c.ping();
		expect(fetchCalls.length).toBe(1);
		const call = fetchCalls[0]!;
		expect(call.url).toBe('https://api.linear.app/graphql');
		expect(call.init.method).toBe('POST');
		const headers = new Headers(call.init.headers);
		expect(headers.get('Authorization')).toBe('lin_xyz');
		expect(headers.get('Content-Type')).toBe('application/json');
		expect(typeof call.init.body).toBe('string');
		const parsed = JSON.parse(call.init.body as string);
		expect(parsed).toHaveProperty('query');
		expect(parsed).toHaveProperty('variables');
	});
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('LinearClient error handling', () => {
	it('throws LinearApiError with statusCode on HTTP failure', async () => {
		enqueueTextResponse('internal server error', 500);
		const c = new LinearClient({ apiKey: 'lin' });
		try {
			await c.getIssue('LIN-1');
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(LinearApiError);
			expect((err as LinearApiError).statusCode).toBe(500);
		}
	});

	it('throws LinearApiError when the response has GraphQL errors', async () => {
		enqueueJsonResponse({ errors: [{ message: 'validation failed' }] });
		const c = new LinearClient({ apiKey: 'lin' });
		try {
			await c.getIssue('LIN-1');
			throw new Error('expected throw');
		} catch (err) {
			expect(err).toBeInstanceOf(LinearApiError);
			expect((err as LinearApiError).graphqlErrors).toEqual([
				{ message: 'validation failed' },
			]);
		}
	});

	it('throws LinearApiError when the response is missing data', async () => {
		enqueueJsonResponse({});
		const c = new LinearClient({ apiKey: 'lin' });
		await expect(c.getIssue('LIN-1')).rejects.toBeInstanceOf(LinearApiError);
	});
});

// ---------------------------------------------------------------------------
// getIssue
// ---------------------------------------------------------------------------

describe('LinearClient.getIssue', () => {
	it('returns the issue when present', async () => {
		enqueueJsonResponse({
			data: {
				issue: {
					id: 'n_1',
					identifier: 'LIN-42',
					title: 'Fix thing',
					description: null,
					priority: 2,
					state: { id: 's1', name: 'In Progress', type: 'started' },
					team: { id: 't1', key: 'LIN' },
					url: 'https://linear.app/team/issue/LIN-42',
				},
			},
		});
		const c = new LinearClient({ apiKey: 'lin' });
		const issue = await c.getIssue('LIN-42');
		expect(issue.identifier).toBe('LIN-42');
		expect(issue.state.type).toBe('started');
	});

	it('throws when issue is null', async () => {
		enqueueJsonResponse({ data: { issue: null } });
		const c = new LinearClient({ apiKey: 'lin' });
		await expect(c.getIssue('LIN-999')).rejects.toBeInstanceOf(LinearApiError);
	});
});

// ---------------------------------------------------------------------------
// listActiveCycleIssues
// ---------------------------------------------------------------------------

describe('LinearClient.listActiveCycleIssues', () => {
	it('returns an empty array when team has no active cycle', async () => {
		enqueueJsonResponse({ data: { team: { activeCycle: null } } });
		const c = new LinearClient({ apiKey: 'lin' });
		const issues = await c.listActiveCycleIssues('LIN');
		expect(issues).toEqual([]);
	});

	it('returns the nodes when active cycle has issues', async () => {
		enqueueJsonResponse({
			data: {
				team: {
					activeCycle: {
						issues: {
							nodes: [
								{
									id: 'n1',
									identifier: 'LIN-1',
									title: 'a',
									description: null,
									priority: 1,
									state: { id: 's1', name: 'Todo', type: 'unstarted' },
									team: { id: 't1', key: 'LIN' },
									url: 'https://x/LIN-1',
								},
							],
						},
					},
				},
			},
		});
		const c = new LinearClient({ apiKey: 'lin' });
		const issues = await c.listActiveCycleIssues('LIN');
		expect(issues).toHaveLength(1);
		expect(issues[0]!.identifier).toBe('LIN-1');
	});

	it('throws when team is not found', async () => {
		enqueueJsonResponse({ data: { team: null } });
		const c = new LinearClient({ apiKey: 'lin' });
		await expect(c.listActiveCycleIssues('NOPE')).rejects.toBeInstanceOf(LinearApiError);
	});
});

// ---------------------------------------------------------------------------
// updateIssueState
// ---------------------------------------------------------------------------

describe('LinearClient.updateIssueState', () => {
	it('returns the updated issue on success', async () => {
		enqueueJsonResponse({
			data: {
				issueUpdate: {
					success: true,
					issue: {
						id: 'n1',
						identifier: 'LIN-1',
						title: 'a',
						description: null,
						priority: 1,
						state: { id: 's2', name: 'Done', type: 'completed' },
						team: { id: 't1', key: 'LIN' },
						url: 'https://x/LIN-1',
					},
				},
			},
		});
		const c = new LinearClient({ apiKey: 'lin' });
		const issue = await c.updateIssueState('n1', 's2');
		expect(issue.state.type).toBe('completed');
	});

	it('throws when success is false', async () => {
		enqueueJsonResponse({
			data: {
				issueUpdate: {
					success: false,
					issue: null,
				},
			},
		});
		const c = new LinearClient({ apiKey: 'lin' });
		await expect(c.updateIssueState('n1', 's2')).rejects.toBeInstanceOf(LinearApiError);
	});
});

// ---------------------------------------------------------------------------
// addComment
// ---------------------------------------------------------------------------

describe('LinearClient.addComment', () => {
	it('returns the created comment id on success', async () => {
		enqueueJsonResponse({
			data: {
				commentCreate: {
					success: true,
					comment: { id: 'c1' },
				},
			},
		});
		const c = new LinearClient({ apiKey: 'lin' });
		const id = await c.addComment('n1', 'hello');
		expect(id).toBe('c1');
	});

	it('throws on success=false', async () => {
		enqueueJsonResponse({
			data: { commentCreate: { success: false, comment: null } },
		});
		const c = new LinearClient({ apiKey: 'lin' });
		await expect(c.addComment('n1', 'hi')).rejects.toBeInstanceOf(LinearApiError);
	});
});

// ---------------------------------------------------------------------------
// createIssue
// ---------------------------------------------------------------------------

describe('LinearClient.createIssue', () => {
	it('returns the created issue on success', async () => {
		enqueueJsonResponse({
			data: {
				issueCreate: {
					success: true,
					issue: {
						id: 'n_new',
						identifier: 'LIN-100',
						title: 'New thing',
						description: 'desc',
						priority: 2,
						state: { id: 's1', name: 'Todo', type: 'unstarted' },
						team: { id: 't1', key: 'LIN' },
						url: 'https://x/LIN-100',
					},
				},
			},
		});
		const c = new LinearClient({ apiKey: 'lin' });
		const issue = await c.createIssue({
			teamId: 't1',
			title: 'New thing',
			description: 'desc',
		});
		expect(issue.identifier).toBe('LIN-100');
	});
});

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

describe('LinearClient.ping', () => {
	it('returns true on successful viewer query', async () => {
		enqueueJsonResponse({ data: { viewer: { id: 'u1' } } });
		const c = new LinearClient({ apiKey: 'lin' });
		expect(await c.ping()).toBe(true);
	});

	it('returns false on any error (network, auth, etc.)', async () => {
		enqueueTextResponse('unauthorized', 401);
		const c = new LinearClient({ apiKey: 'lin' });
		expect(await c.ping()).toBe(false);
	});
});
