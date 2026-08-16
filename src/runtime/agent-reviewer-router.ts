import type { AgentProviderId } from './agent-session.ts';
import type {
	RuntimeExecutionInput,
	RuntimeReviewer,
	RuntimeReviewResult,
} from './run-runtime.ts';

export class AgentReviewerRouter implements RuntimeReviewer {
	readonly #reviewers: Readonly<Record<AgentProviderId, RuntimeReviewer>>;

	constructor(reviewers: Readonly<Record<AgentProviderId, RuntimeReviewer>>) {
		this.#reviewers = reviewers;
	}

	review(input: RuntimeExecutionInput): Promise<RuntimeReviewResult> {
		return this.#reviewers[input.providerId ?? 'claude'].review(input);
	}
}
