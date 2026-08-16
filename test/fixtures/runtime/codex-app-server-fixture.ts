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
	}
}
