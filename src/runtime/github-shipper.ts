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
// reported, or GitHub could still land it with nobody watching. A pull
// request closed without merging gets the same take-down (GSHIP-641): it is
// the other ending that would otherwise leave a previous arming intact, and a
// closed pull request can be reopened later with nobody watching either.
//
// Every `gh` command receives an allowlisted environment with no token
// variables, so authentication always belongs to gh's own credential store.
//
// Every `gh` failure passes through the single #checked classification point:
// GitHub being unavailable (HTTP 5xx, a timeout, or a network or name
// resolution failure gh itself reports) from GitHub deciding the answer is no
// (a conflict, a denied permission, a refusal). Only the four commands this
// file already documents as idempotent — reusing the pull request, arming
// auto-merge, reading its state, and updating the branch to clear BEHIND —
// retry an unavailable answer, with a small fixed number of attempts and
// total window, before giving up. A decision fails on the spot, exactly as
// before. When the retries reading the pull request's state run out, the
// ship ends as unconfirmed rather than failed: GitHub may already have
// merged the commit and simply could not be asked, which is not the same
// thing as it refusing to (GSHIP-625).
//
// A pull request the monitor finds BEHIND is a third category, next to
// unavailability and decision (GSHIP-625): using intake to archive, approve
// or promote during a run commits to main outside this ship, so the branch
// falls behind and GitHub refuses to merge it — nobody decided against the
// change and GitHub was never unreachable, the branch is just stale. The
// monitor updates the branch itself and keeps watching instead of waiting out
// the merge timeout, then fetches and hard-resets this ship's own worktree to
// the resulting head — without that sync this ship's next push would be
// rejected as non-fast-forward, exactly the idempotent-retry invariant above
// this update is not allowed to break. The updated head is registered as the
// head this ship published, which is the point the recovery turns on: without
// it, the next poll would read the update as a head moved outside the service
// and the GSHIP-615 guard would end the ship over its own recovery. That
// guard still has to refuse a head moved by anyone else, so only a poll that
// finds the head unchanged from what this ship last published is read as
// BEHIND and resolved; any other head still ends the ship as a divergence.
// Branch updates are capped at a small fixed number per ship so a main that
// never stops advancing cannot turn this into an infinite loop; exhausting
// the cap ends the ship with that reason stated plainly. GitHub staying
// unavailable while updating the branch or reading the result ends the ship
// as unconfirmed, the same as any other read (GSHIP-625): the update may have
// already landed and simply could not be confirmed.
//
// BLOCKED is a fourth category the monitor only used to wait out (GSHIP-646):
// GitHub reports BLOCKED for several reasons, and a required check it has
// already completed in failure is one of them — a decision, in the same
// classification GSHIP-625 drew 503 out of, not unavailability and not a
// wait. The evidence was the GSHIP-639 run: CI failed, the pull request went
// BLOCKED, and the monitor kept polling BLOCKED for the rest of the
// hour-long timeout with nothing to show for it. So a BLOCKED poll on the
// head this ship still recognises as its own asks GitHub for the pull
// request's required checks and ends the ship the moment one of them is
// reported completed in failure, naming it in the failure and in its own
// event, with the same auto-merge take-down (GSHIP-616) every other
// non-merge ending here already performs — no merge, no branch deletion. A
// required check still running leaves BLOCKED exactly the wait it already
// was. `gh pr checks` is read outside `#checked`: its documented exit codes
// mean failure and pending checks can both leave a non-zero exit sitting
// next to a perfectly good JSON answer on stdout, so whatever the exit code,
// stdout that parses as the checks array is trusted over it — only a stdout
// that does not parse falls back to the exit code to tell an unavailable
// answer from a decision. GitHub staying unavailable retries with the same
// fixed backoff as the four commands above, but exhausting that budget here
// does not end the ship at all, unconfirmed or otherwise: unlike reading the
// merge state itself, this is a second opinion the ship can simply ask for
// again on the next poll.

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
/**
 * Backoff before retrying an idempotent `gh` command GitHub reported
 * unavailable. Small and fixed on purpose: this smooths over the kind of blip
 * the evidence for GSHIP-625 recorded (a 503 immediately followed by GitHub
 * finishing the merge on its own), not an extended outage — the big picture
 * ship already retries as a whole on the next attempt.
 */
const DEFAULT_UNAVAILABLE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
/**
 * Ceiling on branch updates one ship triggers to clear BEHIND. Small and
 * fixed on purpose: a main branch that keeps advancing while this ship polls
 * must not turn the recovery into an infinite loop.
 */
const DEFAULT_MAX_BRANCH_UPDATES = 3;

const HTTP_5XX_PATTERN = /\bHTTP\/?\s*5\d{2}\b/i;
const TIMEOUT_PATTERN = /\b(timed?\s?-?out|timeout|deadline exceeded)\b/i;
const NETWORK_PATTERN =
	/\b(dial tcp|no such host|could not resolve host|connection refused|connection reset|network is unreachable|temporary failure in name resolution|TLS handshake timeout)\b/i;

/**
 * GitHub being unavailable — HTTP 5xx, a timeout, or a network or name
 * resolution failure gh itself reports — as opposed to GitHub deciding the
 * answer is no (a conflict, a denied permission, a refusal), which is every
 * other non-zero exit and is never retried.
 */
function isGithubUnavailable(detail: string): boolean {
	return HTTP_5XX_PATTERN.test(detail) || TIMEOUT_PATTERN.test(detail) || NETWORK_PATTERN.test(detail);
}

/** Thrown only once an idempotent `gh` command exhausts its retry budget while GitHub stays unavailable. */
class GithubUnavailableError extends Error {}

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
	/** Backoff schedule for retrying an idempotent `gh` command GitHub reports unavailable. */
	unavailableRetryDelaysMs?: number[];
	/** Ceiling on branch updates one ship triggers to clear BEHIND before giving up. */
	maxBranchUpdates?: number;
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

/** One required check as `gh pr checks --required` buckets it: `fail` is the only bucket this file acts on. */
interface RequiredCheck {
	name: string;
	bucket: string;
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

/**
 * Null means stdout was not the checks array `gh pr checks --required --json
 * name,state,bucket` reports on success — never thrown, since this is read
 * regardless of exit code and an unparseable answer is exactly the signal
 * that falls back to classifying the exit code instead (GSHIP-646).
 */
function parseRequiredChecks(json: string): RequiredCheck[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const checks: RequiredCheck[] = [];
	for (const entry of parsed) {
		const check = entry as { name?: unknown; bucket?: unknown };
		if (typeof check?.name === 'string' && typeof check?.bucket === 'string') {
			checks.push({ name: check.name, bucket: check.bucket });
		}
	}
	return checks;
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
	readonly #unavailableRetryDelaysMs: number[];
	readonly #maxBranchUpdates: number;

	constructor(options: GithubShipperOptions = {}) {
		this.#runCommand = options.runCommand ?? defaultShipCommand;
		this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.#mergeTimeoutMs = options.mergeTimeoutMs ?? DEFAULT_MERGE_TIMEOUT_MS;
		this.#unavailableRetryDelaysMs =
			options.unavailableRetryDelaysMs ?? DEFAULT_UNAVAILABLE_RETRY_DELAYS_MS;
		this.#maxBranchUpdates = options.maxBranchUpdates ?? DEFAULT_MAX_BRANCH_UPDATES;
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
			{ retryIdempotent: true },
		);
		input.emit('ship.automerge-armed', { prNumber, headSha });

		return await this.#awaitMerge(input, prNumber, branch, headSha);
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
			// GSHIP-641: a previous ship attempt may have left auto-merge armed on
			// this pull request. If it is reopened later, that stale arming must
			// not be able to land it with nobody watching, so it comes down here
			// too, the same way a diverged head already does.
			await this.#disarmAutoMerge(input, pullRequest.number);
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
	 * Take the arming off a pull request this ship is ending on: a head it just
	 * refused, or a pull request closed without merging (GSHIP-641) — either
	 * way, GitHub must not be able to land it later with nobody watching, for
	 * instance if a closed pull request is reopened. `--disable-auto` is
	 * idempotent: a pull request with nothing armed — never armed, already
	 * disarmed, already merged — is exactly where we want it, so gh's refusal is
	 * recorded and no more than that.
	 *
	 * The disarm never decides the ship's outcome: whether it worked or not, the
	 * original reason the ship is ending stays the reported one. Only
	 * cancellation still belongs to the runtime, so it is the one error that
	 * keeps propagating.
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
	 * The retries reading the pull request's state ran out while GitHub stayed
	 * unavailable. This is deliberately not the same failure as a real merge
	 * failure: the merge may already have landed and this ship simply could not
	 * ask, which is exactly the confusion GSHIP-625 recorded — a 503 on `gh pr
	 * view` a second before GitHub finished the merge, reported to the operator
	 * as though the merge itself had failed. Nothing here re-arms or disarms
	 * auto-merge or touches the branch; the ship just stops trying to look.
	 */
	async #unconfirmed(
		input: RuntimeShipInput,
		prNumber: number,
		headSha: string,
		error: GithubUnavailableError,
	): Promise<RuntimeShipResult> {
		input.emit('ship.merge-unconfirmed', { prNumber, headSha, detail: error.message });
		return {
			outcome: 'failed',
			detail:
				`pull request #${prNumber} merge could not be confirmed: ${error.message} ` +
				'— this is not a merge failure, GitHub may already have merged it; check the ' +
				'pull request directly before shipping again',
		};
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
		], { retryIdempotent: true });
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
	 *
	 * `headSha` tracks the head this ship published and is reassigned when this
	 * ship resolves BEHIND by updating the branch itself — every check after
	 * that point, including GSHIP-615's divergence guard, compares against the
	 * updated head, not the one originally pushed.
	 */
	async #awaitMerge(
		input: RuntimeShipInput,
		prNumber: number,
		branch: string,
		initialHeadSha: string,
	): Promise<RuntimeShipResult> {
		const deadline = Date.now() + this.#mergeTimeoutMs;
		let lastStatus = '';
		let headSha = initialHeadSha;
		let branchUpdates = 0;
		for (;;) {
			const step = await this.#pollOnce(input, prNumber, branch, headSha, branchUpdates);
			if ('result' in step) return step.result;
			headSha = step.headSha;
			branchUpdates = step.branchUpdates;
			// A poll that resolved BEHIND already reported its own event; it is
			// not a pending status and does not spend the merge timeout.
			if (step.pending === null) continue;
			if (step.pending !== lastStatus) {
				lastStatus = step.pending;
				input.emit('ship.merge-pending', { prNumber, mergeStateStatus: lastStatus });
			}
			if (Date.now() >= deadline) {
				return {
					outcome: 'failed',
					detail: `pull request #${prNumber} did not merge within ${this.#mergeTimeoutMs}ms (${lastStatus})`,
				};
			}
			await sleep(this.#pollIntervalMs, input.signal);
			if (input.signal.aborted) throw new DOMException('cancelled', 'AbortError');
		}
	}

	/**
	 * Read one poll of the pull request and interpret it: a terminal result if
	 * the poll settles the ship (merged, closed, diverged, or GitHub stayed
	 * unreachable through its retries), otherwise the loop state to continue
	 * with. `headSha` is reassigned here when this ship resolves BEHIND by
	 * updating the branch itself, so every later check — including
	 * GSHIP-615's divergence guard — compares against the updated head, not
	 * the one originally pushed. `pending` is null right after such an
	 * update: that poll already reported its own event and must not also
	 * count as a pending status or spend the merge timeout.
	 */
	async #pollOnce(
		input: RuntimeShipInput,
		prNumber: number,
		branch: string,
		headSha: string,
		branchUpdates: number,
	): Promise<
		| { result: RuntimeShipResult }
		| { headSha: string; branchUpdates: number; pending: string | null }
	> {
		let view: PullRequestView;
		try {
			view = parsePullRequestView(await this.#checked(input, 'gh', [
				'pr', 'view', String(prNumber), '--json', 'state,mergeStateStatus,headRefOid',
			], { retryIdempotent: true }));
		} catch (error) {
			if (error instanceof GithubUnavailableError) {
				return { result: await this.#unconfirmed(input, prNumber, headSha, error) };
			}
			throw error;
		}
		// BEHIND on the head this ship still recognises as its own is not a
		// divergence and not an outage: main advanced while this ship waited.
		// A BEHIND head that is not ours falls through to #pollVerdict below,
		// which reports it as a divergence like any other.
		if (view.state === 'OPEN' && view.mergeStateStatus === 'BEHIND' && view.headRefOid === headSha) {
			if (branchUpdates >= this.#maxBranchUpdates) {
				return {
					result: {
						outcome: 'failed',
						detail: `pull request #${prNumber} stayed BEHIND after ${this.#maxBranchUpdates} branch updates: giving up so a main that keeps advancing cannot loop this ship forever`,
					},
				};
			}
			try {
				const updated = await this.#updateBranch(input, prNumber, branch, headSha);
				return { headSha: updated, branchUpdates: branchUpdates + 1, pending: null };
			} catch (error) {
				if (error instanceof GithubUnavailableError) {
					return { result: await this.#unconfirmed(input, prNumber, headSha, error) };
				}
				throw error;
			}
		}
		const blocked = await this.#pollBlocked(input, prNumber, headSha, view);
		if (blocked !== null) return { result: blocked };
		const verdict = await this.#pollVerdict(input, prNumber, headSha, view);
		if (verdict !== null) return { result: verdict };
		return { headSha, branchUpdates, pending: view.mergeStateStatus };
	}

	/**
	 * BLOCKED on the head this ship still recognises as its own may be a
	 * required check GitHub already completed in failure — a decision, not the
	 * wait BLOCKED otherwise is (GSHIP-646). A BEHIND head that is not ours is
	 * already handled above #pollOnce's call to this; a BLOCKED head that is
	 * not ours is left to #pollVerdict, which reports it as a divergence like
	 * any other, so this only ever asks about the head this ship published.
	 */
	async #pollBlocked(
		input: RuntimeShipInput,
		prNumber: number,
		headSha: string,
		view: PullRequestView,
	): Promise<RuntimeShipResult | null> {
		if (view.state !== 'OPEN' || view.mergeStateStatus !== 'BLOCKED' || view.headRefOid !== headSha) {
			return null;
		}
		const failedCheck = await this.#failedRequiredCheck(input, prNumber);
		if (failedCheck === null) return null;
		return await this.#requiredCheckFailed(input, prNumber, headSha, failedCheck);
	}

	/**
	 * A required check GitHub reports completed in failure ends the ship here
	 * (GSHIP-646), naming the check so the cause shows up in the run's history.
	 * The armed auto-merge comes down first (GSHIP-616), the same as every
	 * other ending in this file that is not a merge — nothing is merged and no
	 * branch is deleted.
	 */
	async #requiredCheckFailed(
		input: RuntimeShipInput,
		prNumber: number,
		headSha: string,
		checkName: string,
	): Promise<RuntimeShipResult> {
		await this.#disarmAutoMerge(input, prNumber);
		input.emit('ship.required-check-failed', { prNumber, headSha, check: checkName });
		return {
			outcome: 'failed',
			detail: `pull request #${prNumber} is blocked: required check "${checkName}" completed in failure`,
		};
	}

	/**
	 * Consulted only once a poll finds the pull request BLOCKED: the name of
	 * the first required check GitHub reports completed in failure, or null
	 * when none has — a required check still running is exactly the wait
	 * BLOCKED already was before this existed, and so is no required checks
	 * being reported at all.
	 *
	 * This reads outside `#checked` on purpose: `gh pr checks` documents a
	 * non-zero exit both for a failing check and for one still pending, so a
	 * usable JSON answer can sit on stdout right next to an exit code
	 * `#checked` would otherwise throw on unread. Stdout that parses as the
	 * checks array is trusted whatever the exit code; only a stdout that does
	 * not parse falls back to the exit code, and only then to tell GitHub
	 * being unavailable from a decision. Unavailable retries with the same
	 * fixed backoff as every other idempotent `gh` read in this file, but
	 * exhausting that budget here never fails the ship, and neither does a
	 * decision: unlike reading the merge state itself, this is a second
	 * opinion, and the next poll simply asks again.
	 */
	async #failedRequiredCheck(input: RuntimeShipInput, prNumber: number): Promise<string | null> {
		for (let attempt = 0; ; attempt++) {
			const checked = await this.#run(input, 'gh', [
				'pr', 'checks', String(prNumber), '--required', '--json', 'name,state,bucket',
			]);
			const checks = parseRequiredChecks(checked.stdout);
			if (checks !== null) return checks.find((check) => check.bucket === 'fail')?.name ?? null;
			if (checked.exitCode === 0) return null;
			const detail = failureDetail(checked);
			if (!isGithubUnavailable(detail) || attempt >= this.#unavailableRetryDelaysMs.length) return null;
			input.emit('ship.github-unavailable', {
				command: 'gh',
				args: ['pr', 'checks'],
				attempt: attempt + 1,
				detail,
			});
			await sleep(this.#unavailableRetryDelaysMs[attempt] ?? 0, input.signal);
			if (input.signal.aborted) throw new DOMException('cancelled', 'AbortError');
		}
	}

	/**
	 * Update the pull request branch with the latest base commit, read back the
	 * head GitHub records afterwards, then sync this ship's own worktree to
	 * that head. The sync is not cosmetic: without it, the branch this ship
	 * checked out stays behind the commit GitHub just added, so this ship's
	 * next push — an operator retry, or this same worktree used again later —
	 * would be rejected as non-fast-forward, and every head comparison after
	 * this point, including GSHIP-615's divergence guard, would read against a
	 * stale local HEAD.
	 */
	async #updateBranch(
		input: RuntimeShipInput,
		prNumber: number,
		branch: string,
		previousHead: string,
	): Promise<string> {
		await this.#checked(input, 'gh', ['pr', 'update-branch', String(prNumber)], { retryIdempotent: true });
		const updated = parsePullRequestView(await this.#checked(input, 'gh', [
			'pr', 'view', String(prNumber), '--json', 'state,mergeStateStatus,headRefOid',
		], { retryIdempotent: true }));
		await this.#checked(input, 'git', ['fetch', 'origin', branch]);
		await this.#checked(input, 'git', ['reset', '--hard', updated.headRefOid]);
		input.emit('ship.branch-updated', { prNumber, previousHead, headSha: updated.headRefOid });
		return updated.headRefOid;
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
			// GSHIP-641: same take-down as a diverged head — the arming this ship
			// placed outlives the closed pull request, so a later reopen must not
			// find it still armed.
			await this.#disarmAutoMerge(input, prNumber);
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

	/**
	 * The single point every `gh` (and git) failure passes through. `retryIdempotent`
	 * is set only at the four call sites this file already documents as
	 * idempotent — reusing the pull request, arming auto-merge, reading its
	 * state, updating the branch to clear BEHIND — and only then does an
	 * unavailable answer get retried; a decision still fails on the spot, here
	 * or anywhere else `#checked` is called. Reading a BLOCKED pull request's
	 * required checks (GSHIP-646) is read outside this method instead, since a
	 * failed or pending check can leave a non-zero exit next to a usable
	 * answer on stdout, which `#checked` would discard unread.
	 */
	async #checked(
		input: RuntimeShipInput,
		command: string,
		args: string[],
		options: { retryIdempotent?: boolean } = {},
	): Promise<string> {
		const retryIdempotent = options.retryIdempotent ?? false;
		const label = args.slice(0, 2).join(' ');
		for (let attempt = 0; ; attempt++) {
			const result = await this.#run(input, command, args);
			if (result.exitCode === 0) return result.stdout.trim();
			const detail = failureDetail(result);
			if (!retryIdempotent || command !== 'gh' || !isGithubUnavailable(detail)) {
				throw new Error(`${command} ${label} failed: ${detail}`);
			}
			if (attempt >= this.#unavailableRetryDelaysMs.length) {
				throw new GithubUnavailableError(
					`${command} ${label} still failing after ${attempt + 1} attempts: ` +
						`GitHub appears unavailable: ${detail}`,
				);
			}
			input.emit('ship.github-unavailable', {
				command,
				args: args.slice(0, 2),
				attempt: attempt + 1,
				detail,
			});
			await sleep(this.#unavailableRetryDelaysMs[attempt] ?? 0, input.signal);
			if (input.signal.aborted) throw new DOMException('cancelled', 'AbortError');
		}
	}
}
