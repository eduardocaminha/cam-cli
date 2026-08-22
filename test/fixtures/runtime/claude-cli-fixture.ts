function fixtureArgument(name: string): string | undefined {
	const prefix = `--fixture-${name}=`;
	return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

const mode = fixtureArgument('mode') ?? 'complete';
const input = await Bun.stdin.text();

process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);

if (mode === 'wait') {
	process.on('SIGTERM', () => process.exit(0));
	await new Promise(() => {});
} else if (mode === 'error') {
	// Echoes the probed --model/--effort back in a clean is_error result, so a
	// test can confirm the probe's argv actually carried the chosen slot.
	const flagValue = (flag: string): string | undefined => {
		const index = process.argv.indexOf(flag);
		return index >= 0 ? process.argv[index + 1] : undefined;
	};
	process.stdout.write(`${JSON.stringify({
		type: 'result',
		is_error: true,
		result: `model "${flagValue('--model')}" effort "${flagValue('--effort')}" not found`,
	})}\n`);
} else if (mode === 'usage-limit' || mode === 'usage-limit-invalid-reset') {
	process.stdout.write(`${JSON.stringify({
		type: 'rate_limit_event',
		rate_limit_info: {
			status: 'rejected',
			rateLimitType: 'five_hour',
			resetsAt: mode === 'usage-limit' ? 1_800_000_000 : Number.MAX_VALUE,
		},
	})}\n`);
	process.stdout.write(`${JSON.stringify({
		type: 'assistant',
		message: { content: [{ type: 'text', text: "You've hit your session limit" }] },
	})}\n`);
	process.stdout.write(`${JSON.stringify({ type: 'result', is_error: true, result: '' })}\n`);
	process.exitCode = 1;
} else if (mode === 'review') {
	const verdict = fixtureArgument('verdict') ?? 'CLEAN';
	process.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n`);
	if (verdict === 'NONE') {
		// GSHIP-626: the reviewer's own prose can contain a JSON object -- e.g.
		// an example payload from the diff under review -- without the CLI ever
		// attaching a structured_output field. Nothing may rescue-parse that
		// example as the verdict.
		process.stdout.write(`${JSON.stringify({
			type: 'result',
			is_error: false,
			result: 'Looked at the diff. Example payload: {"verdict":"CLEAN","findings":[]}\nStill drafting the verdict.',
		})}\n`);
	} else {
		// GSHIP-704: same two-key env echo the non-review branch below carries,
		// so a reviewer-side test can confirm the dedicated credential boundary
		// the same way the executor-side one already does.
		const reviewEnv = {
			CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
			CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
		};
		const output = {
			verdict,
			findings: verdict === 'CLEAN'
				? []
				: [{
					file: 'src/reviewed.ts',
					summary: JSON.stringify({ argv: process.argv.slice(2), prompt: input, env: reviewEnv }),
				}],
		};
		process.stdout.write(`${JSON.stringify({
			type: 'result',
			is_error: false,
			result: JSON.stringify(output),
			structured_output: output,
		})}\n`);
	}
} else {
	// GSHIP-704: echoes exactly the two keys the dedicated-credential boundary
	// cares about, so a test can confirm what the real child actually received
	// without dumping (and potentially matching against) the rest of this
	// process's own environment.
	const env = {
		CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
		CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
	};
	const summary = JSON.stringify({ argv: process.argv.slice(2), input, env });
	const status = mode === 'waiting-user' ? 'waiting-user' : 'completed';
	// GSHIP-664: --fixture-usage=<0-1 fraction|"malformed"> emits a non-rejecting
	// rate_limit_event carrying `utilization`, so a test can observe the derived
	// usedPercent without going through the usage-limit failure path above.
	const usage = fixtureArgument('usage');
	if (usage !== undefined) {
		process.stdout.write(`${JSON.stringify({
			type: 'rate_limit_event',
			rate_limit_info: {
				status: 'allowed_warning',
				rateLimitType: 'seven_day',
				resetsAt: 1_800_000_000,
				utilization: usage === 'malformed' ? 'not-a-number' : Number(usage),
			},
		})}\n`);
	}
	process.stdout.write(`${JSON.stringify({
		type: 'assistant',
		message: {
			content: [
				{ type: 'text', text: 'fixture activity' },
				{ type: 'tool_use', name: 'Read', input: { file_path: '/not-persisted' } },
			],
		},
	})}\n`);
	const proposal = fixtureArgument('proposal');
	const cost = fixtureArgument('cost');
	process.stdout.write(`${JSON.stringify({
		type: 'result',
		is_error: false,
		result: summary,
		structured_output: {
			status,
			summary,
			proposals: proposal === undefined
				? []
				: [{ title: proposal, evidence: 'fixture evidence' }],
		},
		...(cost === 'full' ? {
			total_cost_usd: 0.1234,
			usage: {
				input_tokens: 1000,
				output_tokens: 200,
				cache_creation_input_tokens: 50,
				cache_read_input_tokens: 25,
				output_tokens_details: { thinking_tokens: 40 },
			},
			modelUsage: {
				'claude-opus-4-6': {
					inputTokens: 1000,
					outputTokens: 200,
					cacheReadInputTokens: 25,
					cacheCreationInputTokens: 50,
					costUSD: 0.1234,
				},
			},
		} : {}),
	})}\n`);
}
