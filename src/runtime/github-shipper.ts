// src/runtime/github-shipper.ts
//
// The ship role: turn the verified change sitting in a run's own worktree into
// a merged pull request, and report merged only when GitHub really merged it.
//
// Two invariants shape the whole file:
//
//   * The issue is closed on the BRANCH, never on main. `stage:'shipped'` is
//     written into the worktree copy of .gateship/issues/<ID>.json and rides
//     the same commit as the change, so main learns the issue shipped by
//     composing the merge. Nothing here ever writes refs/heads/main.
//   * Every step is idempotent. A repeated ship reuses the commit it already
//     made (nothing staged, no second commit) and the pull request already open
//     for the branch (`gh pr list --head`), so retrying after a GitHub or CI
//     failure never duplicates either.
//   * Once GitHub confirms the merge, the runtime source ref is refreshed
//     before the ship reports merged, so the next run starts from the commit
//     this one landed. That refresh writes `refs/remotes/origin/main` only.
//
// Auto-merge is armed with `--match-head-commit <sha>`, the exact commit we
// pushed, but that pin is GitHub's promise, not ours: a branch moved outside
// the service has been merged with the armed auto-merge still in place. So the
// ship keeps the sha it pushed and re-checks it on every poll against the pull
// request's own `headRefOid`. A head that is not the one we published ends the
// ship as a failure — no merge, no re-arming, no branch deletion — and reports
// merged only while the head GitHub merged is still the head we pushed. Ending
// the ship is not enough on its own: the arming outlives this process, so a
// refused head is disarmed with `--disable-auto` before the failure is
// reported, or GitHub could still land it with nobody watching.
//
// Every `gh` command receives an allowlisted environment with no token
// variables, so authentication always belongs to gh's own credential store.

import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { issueFilePath } from '../issues/backlog.ts';
import { buildGithubCliEnv } from './child-env.ts';
import { type CommandResult, runOwnedCommand } from './git-runtime.ts';
import type { RuntimeShipInput, RuntimeShipper, RuntimeShipResult } from './run-runtime.ts';
import { RUNTIME_SOURCE_REF, runtimeSourceFetchArgs } from './source-ref.ts';

/** How often the merge monitor asks GitHub whether the pull request landed. */
const DEFAULT_POLL_INTERVAL_MS = 10_000;
/** Ceiling on one monitor. A slow or wedged CI ends as a retryable failure. */
const DEFAULT_MERGE_TIMEOUT_MS = 60 * 60 * 1_000;

export interface ShipCommandInput {
	cwd: string;
	command: string;
	args: string[];
	signal: AbortSignal;
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
	/** The head GitHub currently records for the branch, empty when unreported. */
	headRefOid: string;
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

function defaultShipCommand(input: ShipCommandInput): Promise<CommandResult> {
	return runOwnedCommand({
		cmd: [input.command, ...input.args],
		cwd: input.cwd,
		signal: input.signal,
		...(input.command === 'gh' ? { env: buildGithubCliEnv(process.env) } : {}),
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
	const view = parsed as { state?: unknown; mergeStateStatus?: unknown; headRefOid?: unknown };
	return {
		state: typeof view?.state === 'string' ? view.state : 'UNKNOWN',
		mergeStateStatus: typeof view?.mergeStateStatus === 'string' ? view.mergeStateStatus : 'UNKNOWN',
		headRefOid: typeof view?.headRefOid === 'string' ? view.headRefOid : '',
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
		const settled = await this.#settledPullRequest(input, pullRequest, headSha);
		if (settled !== null) return settled;

		const prNumber = pullRequest.number;
		await this.#checked(
			input,
			'gh',
			['pr', 'merge', String(prNumber), '--squash', '--auto', '--match-head-commit', headSha],
		);
		input.emit('ship.automerge-armed', { prNumber, headSha });

		return await this.#awaitMerge(input, prNumber, headSha);
	}

	/**
	 * A pull request that already left the open state ends the ship here. The
	 * armed auto-merge can land the branch while nobody is watching (a monitor
	 * timeout, a cancel, a restart mid-ship), so a retry has to recognise its
	 * own merged pull request instead of opening a second, zero-diff one.
	 */
	async #settledPullRequest(
		input: RuntimeShipInput,
		pullRequest: ExistingPullRequest,
		headSha: string,
	): Promise<RuntimeShipResult | null> {
		if (pullRequest.state === 'MERGED') {
			if (pullRequest.headRefOid !== headSha) {
				return await this.#headDiverged(
					input,
					pullRequest.number,
					headSha,
					pullRequest.headRefOid,
					true,
				);
			}
			return await this.#merged(input, pullRequest.number);
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
	 * The pull request no longer carries the head this ship pushed: the branch
	 * moved outside the service. The armed auto-merge is taken down first, then
	 * the ship ends here as a failure — nothing is merged, no auto-merge is
	 * re-armed and no branch is deleted — and the detection is recorded so it
	 * shows up in the run's history.
	 *
	 * `merged` distinguishes the two moments this is caught: a head that moved
	 * while the monitor was still waiting, and a merge GitHub already performed
	 * on a head this service never verified. An unreported head counts as a
	 * divergence too: a head that cannot be read cannot be the one we published.
	 */
	async #headDiverged(
		input: RuntimeShipInput,
		prNumber: number,
		headSha: string,
		observedHead: string,
		merged: boolean,
	): Promise<RuntimeShipResult> {
		await this.#disarmAutoMerge(input, prNumber);
		const observed = observedHead.length === 0 ? 'an unreported head' : observedHead;
		input.emit('ship.head-diverged', { prNumber, headSha, observedHead, merged });
		return {
			outcome: 'failed',
			detail: merged
				? `pull request #${prNumber} merged ${observed}, not the head ${headSha} this run published: the merge landed a head this service never verified`
				: `pull request #${prNumber} now carries ${observed}, not the head ${headSha} this run pushed: the branch moved outside the service`,
		};
	}

	/**
	 * Take the arming off a pull request whose head this ship just refused, so
	 * GitHub cannot land it later with nobody watching. `--disable-auto` is
	 * idempotent: a pull request with nothing armed — never armed, already
	 * disarmed, already merged — is exactly where we want it, so gh's refusal is
	 * recorded and no more than that.
	 *
	 * The disarm never decides the ship's outcome: whether it worked or not, the
	 * divergence stays the reported reason. Only cancellation still belongs to
	 * the runtime, so it is the one error that keeps propagating.
	 */
	async #disarmAutoMerge(input: RuntimeShipInput, prNumber: number): Promise<void> {
		let detail: string;
		try {
			const disarmed = await this.#run(input, 'gh', [
				'pr', 'merge', String(prNumber), '--disable-auto',
			]);
			if (disarmed.exitCode === 0) {
				input.emit('ship.automerge-disarmed', { prNumber, disarmed: true });
				return;
			}
			detail = failureDetail(disarmed);
		} catch (error) {
			if (input.signal.aborted) throw error;
			detail = errorMessage(error);
		}
		input.emit('ship.automerge-disarmed', { prNumber, disarmed: false, detail });
	}

	/**
	 * The single exit for a merged pull request: refresh the runtime source ref
	 * so the merge this ship just landed is visible to whatever asks next, then
	 * report merged.
	 *
	 * Reporting merged before the refresh would tell the service the backlog
	 * moved while its own source ref still offered the issue as plannable, so a
	 * failed refresh keeps the run retryable instead. Everything before this
	 * point is already idempotent, so the retry re-runs only the sync: it
	 * recognises its own merged pull request and duplicates neither commit nor
	 * pull request.
	 */
	async #merged(input: RuntimeShipInput, prNumber: number): Promise<RuntimeShipResult> {
		const fetched = await this.#run(input, 'git', runtimeSourceFetchArgs());
		if (fetched.exitCode !== 0) {
			return {
				outcome: 'failed',
				detail: `pull request #${prNumber} merged, but ${RUNTIME_SOURCE_REF} could not be refreshed: ${failureDetail(fetched)}`,
			};
		}
		input.emit('ship.source-synced', { prNumber, ref: RUNTIME_SOURCE_REF });
		input.emit('ship.merged', { prNumber });
		return { outcome: 'merged', prNumber };
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
		);
		const opened = parseCreatedPullRequest(created);
		if (opened === null) {
			throw new Error(`gh pr create did not report a pull request number: ${created}`);
		}
		input.emit('ship.pr-opened', { prNumber: opened, branch });
		return { number: opened, state: 'OPEN', headRefOid: headSha };
	}

	/**
	 * Watch the armed pull request until GitHub merges it, closes it, moves off
	 * the head this ship pushed, or time runs out. The head is re-read on every
	 * step: the armed `--match-head-commit` is not enough on its own.
	 */
	async #awaitMerge(
		input: RuntimeShipInput,
		prNumber: number,
		headSha: string,
	): Promise<RuntimeShipResult> {
		const deadline = Date.now() + this.#mergeTimeoutMs;
		let lastStatus = '';
		for (;;) {
			const view = parsePullRequestView(await this.#checked(input, 'gh', [
				'pr', 'view', String(prNumber), '--json', 'state,mergeStateStatus,headRefOid',
			]));
			const verdict = await this.#pollVerdict(input, prNumber, headSha, view);
			if (verdict !== null) return verdict;
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

	/**
	 * What one poll decides: a merge of the head this ship published, a pull
	 * request closed without merging, or a head that is no longer ours. Null is
	 * the only answer that keeps the monitor waiting.
	 */
	async #pollVerdict(
		input: RuntimeShipInput,
		prNumber: number,
		headSha: string,
		view: PullRequestView,
	): Promise<RuntimeShipResult | null> {
		if (view.state === 'MERGED') {
			return view.headRefOid === headSha
				? await this.#merged(input, prNumber)
				: await this.#headDiverged(input, prNumber, headSha, view.headRefOid, true);
		}
		if (view.state === 'CLOSED') {
			return {
				outcome: 'failed',
				detail: `pull request #${prNumber} was closed without merging`,
			};
		}
		if (view.headRefOid !== headSha) {
			return await this.#headDiverged(input, prNumber, headSha, view.headRefOid, false);
		}
		return null;
	}

	async #run(
		input: RuntimeShipInput,
		command: string,
		args: string[],
	): Promise<CommandResult> {
		const result = await this.#runCommand({
			cwd: input.cwd,
			command,
			args,
			signal: input.signal,
		});
		if (input.signal.aborted) throw new DOMException('cancelled', 'AbortError');
		return result;
	}

	async #checked(
		input: RuntimeShipInput,
		command: string,
		args: string[],
	): Promise<string> {
		const result = await this.#run(input, command, args);
		if (result.exitCode !== 0) {
			throw new Error(
				`${command} ${args.slice(0, 2).join(' ')} failed: ${failureDetail(result)}`,
			);
		}
		return result.stdout.trim();
	}
}
