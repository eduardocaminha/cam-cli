import { test } from 'bun:test';

import { createTestTmpdir } from '../helpers/test-tmpdir';

test('creates a scratch dir and reports its path for the parent process', () => {
	const dir = createTestTmpdir('gship-reap-fixture-');
	console.log(`CAM_REAP_FIXTURE_DIR:${dir}`);
});
