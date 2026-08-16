import type { AgentProviderId } from './agent-session.ts';
import type {
	RuntimeExecutionInput,
	RuntimeExecutionResult,
	RuntimeExecutor,
} from './run-runtime.ts';

/** Routes a persisted run to its provider without changing provider on resume. */
export class AgentExecutorRouter implements RuntimeExecutor {
	readonly #executors: Readonly<Record<AgentProviderId, RuntimeExecutor>>;

	constructor(executors: Readonly<Record<AgentProviderId, RuntimeExecutor>>) {
		this.#executors = executors;
	}

	execute(input: RuntimeExecutionInput): Promise<RuntimeExecutionResult> {
		return this.#executors[input.providerId ?? 'claude'].execute(input);
	}
}
