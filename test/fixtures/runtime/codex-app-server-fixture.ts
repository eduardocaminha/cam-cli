// GSHIP-664: --usage-mode selects account/rateLimits/read's response, mirroring
// claude-cli-fixture.ts's --fixture-mode. The default ("absent") answers with a
// null result so a caller that never asked for usage keeps seeing the exact
// same account/read-only status it saw before this existed.
const usageMode = process.argv.find((arg) => arg.startsWith('--usage-mode='))?.slice('--usage-mode='.length)
	?? 'absent';

for await (const line of console) {
	const request = JSON.parse(line) as { id?: number; method?: string };
	if (request.method === 'initialize') {
		process.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: 'fixture' } })}\n`);
	} else if (request.method === 'account/read') {
		process.stdout.write(`${JSON.stringify({
			id: request.id,
			result: { account: { type: 'chatgpt', email: 'not-exposed@example.com', planType: 'plus' }, requiresOpenaiAuth: true },
		})}\n`);
	} else if (request.method === 'account/login/start') {
		process.stdout.write(`${JSON.stringify({
			id: request.id,
			result: { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://chatgpt.com/login-fixture' },
		})}\n`);
	} else if (request.method === 'account/rateLimits/read') {
		if (usageMode === 'reported') {
			process.stdout.write(`${JSON.stringify({
				id: request.id,
				result: {
					rateLimits: {
						limitId: 'codex',
						limitName: null,
						primary: { usedPercent: 21, windowDurationMins: 10_080, resetsAt: 1_787_841_498 },
						secondary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1_787_299_419 },
						credits: { hasCredits: false, unlimited: false, balance: '0' },
						individualLimit: { limit: '$100.00', used: '$42.00', remainingPercent: 58, resetsAt: 1_787_841_498 },
						planType: 'prolite',
						rateLimitReachedType: null,
					},
					rateLimitsByLimitId: { codex: { limitId: 'codex' } },
					rateLimitResetCredits: { availableCount: 2, credits: [] },
				},
			})}\n`);
		} else if (usageMode === 'malformed') {
			process.stdout.write(`${JSON.stringify({
				id: request.id,
				result: { rateLimits: { primary: { usedPercent: 'not-a-number' } } },
			})}\n`);
		} else if (usageMode === 'error') {
			process.stdout.write(`${JSON.stringify({ id: request.id, error: { message: 'rate limits unavailable' } })}\n`);
		} else {
			process.stdout.write(`${JSON.stringify({ id: request.id, result: null })}\n`);
		}
	}
}
