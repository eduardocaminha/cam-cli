// src/linear/client.ts
//
// Minimal Linear GraphQL client used by the orchestrator and `/cam-issue`.
//
// Design notes:
//   - No dependencies. Uses `fetch` (Bun / Node 18+) directly against
//     https://api.linear.app/graphql.
//   - Authentication: Personal API key via the `Authorization` header, value
//     exactly the key (Linear does NOT use `Bearer <key>` for personal keys).
//     The key is read from the LINEAR_API_KEY environment variable — we do
//     not persist it anywhere.
//   - Errors: all methods throw `LinearApiError` on network failure or on
//     a GraphQL `errors` response. Callers should try/catch and surface to
//     the user via printError. The orchestrator will catch and respond in
//     natural language.
//   - Scope: intentionally minimal. Only the operations the orchestrator
//     needs today. Adding new queries should be a one-liner.

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LinearApiError extends Error {
	readonly statusCode: number | null;
	readonly graphqlErrors: unknown;

	constructor(message: string, opts: { statusCode?: number; graphqlErrors?: unknown } = {}) {
		super(message);
		this.name = 'LinearApiError';
		this.statusCode = opts.statusCode ?? null;
		this.graphqlErrors = opts.graphqlErrors ?? null;
	}
}

// ---------------------------------------------------------------------------
// Low-level request
// ---------------------------------------------------------------------------

interface GraphQLResponse<T> {
	data?: T;
	errors?: unknown;
}

async function graphqlRequest<T>(
	apiKey: string,
	query: string,
	variables: Record<string, unknown> = {},
): Promise<T> {
	const res = await fetch(LINEAR_ENDPOINT, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: apiKey,
		},
		body: JSON.stringify({ query, variables }),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new LinearApiError(`Linear API HTTP ${res.status}: ${body.slice(0, 200)}`, {
			statusCode: res.status,
		});
	}

	const json = (await res.json()) as GraphQLResponse<T>;
	if (json.errors) {
		throw new LinearApiError(
			`Linear GraphQL error: ${JSON.stringify(json.errors).slice(0, 300)}`,
			{ graphqlErrors: json.errors },
		);
	}
	if (!json.data) {
		throw new LinearApiError('Linear response missing `data` field');
	}
	return json.data;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LinearIssue {
	id: string;
	identifier: string; // e.g. "LIN-42"
	title: string;
	description: string | null;
	priority: number; // 0 (no priority) → 4 (low)
	state: { id: string; name: string; type: string }; // type: backlog, unstarted, started, completed, canceled
	team: { id: string; key: string }; // e.g. key "LIN"
	url: string;
}

export interface LinearCycle {
	id: string;
	number: number;
	name: string | null;
	startsAt: string; // ISO 8601
	endsAt: string; // ISO 8601
	team: { id: string; key: string };
}

export interface LinearWorkflowState {
	id: string;
	name: string;
	type: string; // backlog, unstarted, started, completed, canceled
	team: { id: string; key: string };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface LinearClientOptions {
	/** Personal API key. Defaults to `process.env.LINEAR_API_KEY`. */
	apiKey?: string;
}

export class LinearClient {
	private readonly apiKey: string;

	constructor(opts: LinearClientOptions = {}) {
		const key = opts.apiKey ?? process.env['LINEAR_API_KEY'];
		if (!key) {
			throw new LinearApiError(
				'LINEAR_API_KEY is not set. Get one at https://linear.app/settings/api',
			);
		}
		this.apiKey = key;
	}

	/** Returns `true` if the API key is valid (whoami succeeds). */
	async ping(): Promise<boolean> {
		try {
			await graphqlRequest<{ viewer: { id: string } }>(
				this.apiKey,
				'query { viewer { id } }',
			);
			return true;
		} catch {
			return false;
		}
	}

	/** Fetch a single issue by identifier (e.g. "LIN-42") or by node id. */
	async getIssue(idOrIdentifier: string): Promise<LinearIssue> {
		const query = `
			query GetIssue($id: String!) {
				issue(id: $id) {
					id
					identifier
					title
					description
					priority
					state { id name type }
					team { id key }
					url
				}
			}
		`;
		const data = await graphqlRequest<{ issue: LinearIssue | null }>(this.apiKey, query, {
			id: idOrIdentifier,
		});
		if (!data.issue) {
			throw new LinearApiError(`Linear issue not found: ${idOrIdentifier}`);
		}
		return data.issue;
	}

	/** List issues in the active cycle for a given team key (e.g. "LIN"). */
	async listActiveCycleIssues(teamKey: string): Promise<LinearIssue[]> {
		const query = `
			query ActiveCycleIssues($teamKey: String!) {
				team(id: $teamKey) {
					activeCycle {
						issues(first: 50) {
							nodes {
								id
								identifier
								title
								description
								priority
								state { id name type }
								team { id key }
								url
							}
						}
					}
				}
			}
		`;
		const data = await graphqlRequest<{
			team: { activeCycle: { issues: { nodes: LinearIssue[] } } | null } | null;
		}>(this.apiKey, query, { teamKey });
		if (!data.team) {
			throw new LinearApiError(`Linear team not found: ${teamKey}`);
		}
		if (!data.team.activeCycle) {
			return [];
		}
		return data.team.activeCycle.issues.nodes;
	}

	/** List all workflow states for a team. Useful to look up IDs by name. */
	async listWorkflowStates(teamKey: string): Promise<LinearWorkflowState[]> {
		const query = `
			query TeamStates($teamKey: String!) {
				team(id: $teamKey) {
					states {
						nodes { id name type team { id key } }
					}
				}
			}
		`;
		const data = await graphqlRequest<{
			team: { states: { nodes: LinearWorkflowState[] } } | null;
		}>(this.apiKey, query, { teamKey });
		if (!data.team) throw new LinearApiError(`Linear team not found: ${teamKey}`);
		return data.team.states.nodes;
	}

	/**
	 * Update an issue's workflow state. `stateId` must be a workflow state node
	 * id belonging to the same team as the issue. Use `listWorkflowStates` to
	 * resolve "In Progress" / "Done" to ids once per session.
	 */
	async updateIssueState(issueId: string, stateId: string): Promise<LinearIssue> {
		const query = `
			mutation UpdateState($id: String!, $stateId: String!) {
				issueUpdate(id: $id, input: { stateId: $stateId }) {
					success
					issue {
						id identifier title description priority
						state { id name type }
						team { id key }
						url
					}
				}
			}
		`;
		const data = await graphqlRequest<{
			issueUpdate: { success: boolean; issue: LinearIssue };
		}>(this.apiKey, query, { id: issueId, stateId });
		if (!data.issueUpdate.success) {
			throw new LinearApiError(`Linear issueUpdate returned success=false for ${issueId}`);
		}
		return data.issueUpdate.issue;
	}

	/** Add a comment to an issue. Returns the created comment id. */
	async addComment(issueId: string, body: string): Promise<string> {
		const query = `
			mutation AddComment($issueId: String!, $body: String!) {
				commentCreate(input: { issueId: $issueId, body: $body }) {
					success
					comment { id }
				}
			}
		`;
		const data = await graphqlRequest<{
			commentCreate: { success: boolean; comment: { id: string } };
		}>(this.apiKey, query, { issueId, body });
		if (!data.commentCreate.success) {
			throw new LinearApiError(`Linear commentCreate returned success=false for ${issueId}`);
		}
		return data.commentCreate.comment.id;
	}

	/**
	 * Create a new issue in a team. `teamId` is the team's node id (not key);
	 * the orchestrator typically resolves key→id once at startup.
	 */
	async createIssue(input: {
		teamId: string;
		title: string;
		description?: string;
		priority?: number;
	}): Promise<LinearIssue> {
		const query = `
			mutation CreateIssue($input: IssueCreateInput!) {
				issueCreate(input: $input) {
					success
					issue {
						id identifier title description priority
						state { id name type }
						team { id key }
						url
					}
				}
			}
		`;
		const data = await graphqlRequest<{
			issueCreate: { success: boolean; issue: LinearIssue };
		}>(this.apiKey, query, { input });
		if (!data.issueCreate.success) {
			throw new LinearApiError(`Linear issueCreate returned success=false`);
		}
		return data.issueCreate.issue;
	}
}
