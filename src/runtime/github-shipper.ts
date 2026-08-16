// src/runtime/github-shipper.ts
//
// The ship role: turn the verified change sitting in a run's own worktree into
// a merged pull request, and report merged only when GitHub really merged it.
//
// Two invariants shape the whole file:
//
//   * The issue is closed on the BRANCH, never on main. `stage:'shipped'` is
//     written into the worktree copy of scripts/cam/issues/<ID>.json and rides
//     the same commit as the change, so main learns the issue shipped by
//     composing the merge. Nothing here ever writes refs/heads/main.
//   * Every step is idempotent. A repeated ship reuses the commit it already
//     made (nothing staged, no second commit) and the pull request already open
//     for the branch (`gh pr list --head`), so retrying after a GitHub or CI
//     failure never duplicates either.
//
// Auto-merge is armed with `--match-head-commit <sha>`, the exact commit we
// pushed: if the branch moves outside the service before CI goes green, GitHub
// refuses the merge instead of shipping a head nobody verified.
//
// `gh` mutations run with GITHUB_TOKEN stripped so gh falls back to its keyring
// OAuth token; the ambient fine-grained PAT lacks "Pull requests: write".

import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { issueFilePath } from '../issues/backlog.ts';
import { type CommandResult, runOwnedCommand } from './git-runtime.ts';
import type { RuntimeShipInput, RuntimeShipper, RuntimeShipResult } from './run-runtime.ts';

/** How often the merge monitor asks GitHub whether the pull request landed. */
const DEFAULT_POLL_INTERVAL_MS = 10_000;
/** Ceiling on one monitor. A slow or wedged CI ends as a retryable failure. */
const DEFAULT_MERGE_TIMEOUT_MS = 60 * 60 * 1_000;

export interface ShipCommandInput {
	cwd: string;
	command: string;
	args: string[];
	signal: AbortSignal;
	/** A gh mutation: drop GITHUB_TOKEN so gh uses its keyring OAuth token. */
	mutation?: boolean;
}

export type ShipCommandRunner = (input: ShipCommandInput) => Promise<CommandResult>;

export interface GithubShipperOptions {
	runCommand?: ShipCommandRunner;
	pollIntervalMs?: number;
	mergeTimeoutMs?: number;
}

interface WorkspaceIssue {
	title: string;
	/** True when this attempt is the one that wrote stage:'shipped'. */
	closed: boolean;
}

interface PullRequestView {
	state: string;
	mergeStateStatus: string;
}

/** The branch's most recent pull request, in whatever state it is now. */
interface ExistingPullRequest {
	number: number;
	state: string;
	headRefOid: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function failureDetail(result: CommandResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
}

function envWithoutGithubToken(): Record<string, string | undefined> {
	const env = { ...process.env };
	delete env['GITHUB_TOKEN'];
	return env;
}

function defaultShipCommand(input: ShipCommandInput): Promise<CommandResult> {
	return runOwnedCommand({
		cmd: [input.command, ...input.args],
		cwd: input.cwd,
		signal: input.signal,
		...(input.mutation === true ? { env: envWithoutGithubToken() } : {}),
	});
}

/** Sleep that gives up as soon as the run is cancelled. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener('abort', finish, { once: true });
	});
}

/**
 * Mark the run's issue as shipped inside the worktree. Returns the issue title
 * for the commit and pull-request subject, and whether anything changed: an
 * issue already marked shipped is left untouched so a retry stages nothing.
 */
function closeIssueInWorkspace(cwd: string, issueId: string): WorkspaceIssue {
	const path = join(cwd, issueFilePath(issueId));
	try {
		if (!lstatSync(path).isFile()) {
			throw new Error('path is not a regular file');
		}
	} catch (error) {
		throw new Error(`run issue path is unsafe: ${errorMessage(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw new Error(`cannot read the run issue in the workspace: ${errorMessage(error)}`);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`run issue in the workspace is not an object: ${path}`);
	}
	const record = parsed as Record<string, unknown>;
	const title = typeof record['title'] === 'string' ? record['title'] : issueId;
	if (record['stage'] === 'shipped') return { title, closed: false };
	const shipped = { ...record, stage: 'shipped', updatedAt: new Date().toISOString() };
	writeFileSync(path, `${JSON.stringify(shipped, null, 2)}\n`);
	return { title, closed: true };
}

function parseExistingPullRequest(json: string): ExistingPullRequest | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error(`gh pr list returned invalid JSON: ${json.slice(0, 200)}`);
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return null;
	const first = parsed[0] as { number?: unknown; state?: unknown; headRefOid?: unknown };
	if (typeof first?.number !== 'number') return null;
	return {
		number: first.number,
		state: typeof first.state === 'string' ? first.state : 'UNKNOWN',
		headRefOid: typeof first.headRefOid === 'string' ? first.headRefOid : '',
	};
}

function parseCreatedPullRequest(output: string): number | null {
	const match = /\/pull\/(\d+)/.exec(output);
	const number = match === null ? Number.NaN : Number.parseInt(match[1] ?? '', 10);
	return Number.isSafeInteger(number) ? number : null;
}

function parsePullRequestView(json: string): PullRequestView {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error(`gh pr view returned invalid JSON: ${json.slice(0, 200)}`);
	}
	const view = parsed as { state?: unknown; mergeStateStatus?: unknown };
	return {
		state: typeof view?.state === 'string' ? view.state : 'UNKNOWN',
		mergeStateStatus: typeof view?.mergeStateStatus === 'string' ? view.mergeStateStatus : 'UNKNOWN',
	};
}

function pullRequestBody(runId: string, issueId: string): string {
	return [
		`Gateship run \`${runId}\` shipping ${issueId}.`,
		'',
		`This branch carries the change and the \`stage:shipped\` update to`,
		`${issueFilePath(issueId)}; main learns the issue shipped by merging this`,
		'pull request, never by a write outside it.',
	].join('\n');
}

export class GithubShipper implements RuntimeShipper {
	readonly #runCommand: ShipCommandRunner;
	readonly #pollIntervalMs: number;
	readonly #mergeTimeoutMs: number;

	constructor(options: GithubShipperOptions = {}) {
		this.#runCommand = options.runCommand ?? defaultShipCommand;
		this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.#mergeTimeoutMs = options.mergeTimeoutMs ?? DEFAULT_MERGE_TIMEOUT_MS;
	}

	async ship(input: RuntimeShipInput): Promise<RuntimeShipResult> {
		try {
			return await this.#ship(input);
		} catch (error) {
			// Cancellation belongs to the runtime; every other failure is a
			// retryable ship failure that must not discard the run's diff.
			if (input.signal.aborted) throw error;
			return { outcome: 'failed', detail: errorMessage(error) };
		}
	}

	async #ship(input: RuntimeShipInput): Promise<RuntimeShipResult> {
		const branch = await this.#checked(input, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
		if (branch === 'main' || branch === 'HEAD') {
			return { outcome: 'failed', detail: `run workspace is not on a ship branch: ${branch}` };
		}

		const issue = closeIssueInWorkspace(input.cwd, input.issueId);
		if (issue.closed) input.emit('ship.issue-closed', { issueId: input.issueId });

		await this.#checked(input, 'git', ['add', '--all']);
		const staged = await this.#run(input, 'git', ['diff', '--cached', '--quiet']);
		if (staged.exitCode === 1) {
			const subject = `${input.issueId}: ${issue.title}`;
			await this.#checked(input, 'git', ['commit', '--message', subject]);
			input.emit('ship.committed', { branch });
		} else if (staged.exitCode !== 0) {
			throw new Error(`cannot read the staged diff: ${failureDetail(staged)}`);
		}

		await this.#checked(input, 'git', ['push', '--set-upstream', 'origin', branch]);
		const headSha = await this.#checked(input, 'git', ['rev-parse', 'HEAD']);
		input.emit('ship.pushed', { branch, headSha });

		const pullRequest = await this.#resolvePullRequest(input, branch, issue.title, headSha);
		const settled = this.#settledPullRequest(input, pullRequest, headSha);
		if (settled !== null) return settled;

		const prNumber = pullRequest.number;
		await this.#checked(
			input,
			'gh',
			['pr', 'merge', String(prNumber), '--squash', '--auto', '--match-head-commit', headSha],
			true,
		);
		input.emit('ship.automerge-armed', { prNumber, headSha });

		return await this.#awaitMerge(input, prNumber);
	}

	/**
	 * A pull request that already left the open state ends the ship here. The
	 * armed auto-merge can land the branch while nobody is watching (a monitor
	 * timeout, a cancel, a restart mid-ship), so a retry has to recognise its
	 * own merged pull request instead of opening a second, zero-diff one.
	 */
	#settledPullRequest(
		input: RuntimeShipInput,
		pullRequest: ExistingPullRequest,
		headSha: string,
	): RuntimeShipResult | null {
		if (pullRequest.state === 'MERGED') {
			if (pullRequest.headRefOid !== headSha) {
				return {
					outcome: 'failed',
					detail: `pull request #${pullRequest.number} merged ${pullRequest.headRefOid}, not the head ${headSha} this run just published`,
				};
			}
			input.emit('ship.merged', { prNumber: pullRequest.number });
			return { outcome: 'merged', prNumber: pullRequest.number };
		}
		if (pullRequest.state === 'CLOSED') {
			return {
				outcome: 'failed',
				detail: `pull request #${pullRequest.number} was closed without merging`,
			};
		}
		return null;
	}

	/**
	 * Reuse the branch's most recent pull request whatever state it is in, or
	 * open the first one. Listing only open pull requests would miss the one
	 * auto-merge already landed and duplicate it.
	 */
	async #resolvePullRequest(
		input: RuntimeShipInput,
		branch: string,
		title: string,
		headSha: string,
	): Promise<ExistingPullRequest> {
		const listed = await this.#checked(input, 'gh', [
			'pr', 'list',
			'--head', branch,
			'--state', 'all',
			'--json', 'number,state,headRefOid',
			'--limit', '1',
		]);
		const existing = parseExistingPullRequest(listed);
		if (existing !== null) {
			input.emit('ship.pr-reused', { prNumber: existing.number, branch, state: existing.state });
			return existing;
		}
		const created = await this.#checked(
			input,
			'gh',
			[
				'pr', 'create',
				'--base', 'main',
				'--head', branch,
				'--title', `${input.issueId}: ${title}`,
				'--body', pullRequestBody(input.runId, input.issueId),
			],
			true,
		);
		const opened = parseCreatedPullRequest(created);
		if (opened === null) {
			throw new Error(`gh pr create did not report a pull request number: ${created}`);
		}
		input.emit('ship.pr-opened', { prNumber: opened, branch });
		return { number: opened, state: 'OPEN', headRefOid: headSha };
	}

	/** Watch the armed pull request until GitHub merges it, closes it, or time runs out. */
	async #awaitMerge(input: RuntimeShipInput, prNumber: number): Promise<RuntimeShipResult> {
		const deadline = Date.now() + this.#mergeTimeoutMs;
		let lastStatus = '';
		for (;;) {
			const view = parsePullRequestView(await this.#checked(input, 'gh', [
				'pr', 'view', String(prNumber), '--json', 'state,mergeStateStatus',
			]));
			if (view.state === 'MERGED') {
				input.emit('ship.merged', { prNumber });
				return { outcome: 'merged', prNumber };
			}
			if (view.state === 'CLOSED') {
				return {
					outcome: 'failed',
					detail: `pull request #${prNumber} was closed without merging`,
				};
			}
			if (view.mergeStateStatus !== lastStatus) {
				lastStatus = view.mergeStateStatus;
				input.emit('ship.merge-pending', { prNumber, mergeStateStatus: view.mergeStateStatus });
			}
			if (Date.now() >= deadline) {
				return {
					outcome: 'failed',
					detail: `pull request #${prNumber} did not merge within ${this.#mergeTimeoutMs}ms (${view.mergeStateStatus})`,
				};
			}
			await sleep(this.#pollIntervalMs, input.signal);
			if (input.signal.aborted) throw new DOMException('cancelled', 'AbortError');
		}
	}

	async #run(
		input: RuntimeShipInput,
		command: string,
		args: string[],
		mutation = false,
	): Promise<CommandResult> {
		const result = await this.#runCommand({
			cwd: input.cwd,
			command,
			args,
			signal: input.signal,
			...(mutation ? { mutation: true } : {}),
		});
		if (input.signal.aborted) throw new DOMException('cancelled', 'AbortError');
		return result;
	}

	async #checked(
		input: RuntimeShipInput,
		command: string,
		args: string[],
		mutation = false,
	): Promise<string> {
		const result = await this.#run(input, command, args, mutation);
		if (result.exitCode !== 0) {
			throw new Error(
				`${command} ${args.slice(0, 2).join(' ')} failed: ${failureDetail(result)}`,
			);
		}
		return result.stdout.trim();
	}
}
