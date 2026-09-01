const mode = process.argv.find((argument) => argument.startsWith('--mode='))?.slice('--mode='.length)
	?? 'wait';

process.on('SIGTERM', () => process.exit(0));

if (mode === 'progress') {
	await Bun.sleep(250);
	process.stdout.write('first\n');
	await Bun.sleep(250);
	process.stdout.write('second\n');
} else if (mode === 'stderr') {
	const noise = setInterval(() => process.stderr.write('provider retry\n'), 10);
	try {
		await new Promise(() => {});
	} finally {
		clearInterval(noise);
	}
} else {
	await new Promise(() => {});
}
