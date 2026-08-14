// test/docs/adr-0065-supersession.test.ts
//
// CAM-565 spec interview (2026-08-14, ADRs 0069/0070) measured the upstream
// (github.com/cosscom/coss) and refuted a claim ADR-0065 records as measured
// fact: the `[data-coss-root]` selector does not exist upstream (zero code
// search results), and upstream DOES use `@theme inline`
// (packages/ui/src/styles/globals.css line 9) with plain `:root` and `.dark`.
//
// This tripwire asserts the correction landed in both surfaces that carry the
// false claim: a supersession note on ADR-0065 and a 2026-08-14 amendment on
// item 13 of memory/project_definicoes_web_headless.md. Token presence alone
// is a weak oracle for prose deliverables (measured 2026-08-14: a checker
// requiring only 'ADR-0069' plus a supersession word stayed GREEN against a
// plausible fabricated note carrying no measurement), so the checkers demand
// the nonexistence claim next to data-coss-root and the `@theme inline`
// mention. The negative tests prove the checkers reject bare text AND the
// plausible fabricated prose.

import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ADR_0065_PATH =
	'docs/adr/0065-a-identidade-visual-e-o-coss-ui-sobre-base-ui-vendorizado-do-registry-publico-e-nao-de-um-worktree-local.md';
const MEMORY_PATH = 'memory/project_definicoes_web_headless.md';

const MEASUREMENT_RE =
	/data-coss-root[^.]*(nao existe|zero resultado)|(nao existe|zero resultado)[^.]*data-coss-root/i;

function missingAdrRequirements(text: string): string[] {
	const missing: string[] = [];
	if (!text.includes('ADR-0069')) missing.push('ADR-0069 pointer');
	if (!/supersed|substitu/i.test(text)) missing.push('supersession wording');
	if (!MEASUREMENT_RE.test(text))
		missing.push('data-coss-root nonexistence measurement');
	if (!text.includes('@theme inline')) missing.push('@theme inline mention');
	return missing;
}

function missingMemoryRequirements(text: string): string[] {
	const missing: string[] = [];
	if (!/Emenda de 2026-08-14/.test(text))
		missing.push('Emenda de 2026-08-14 heading');
	if (!MEASUREMENT_RE.test(text))
		missing.push('data-coss-root nonexistence measurement');
	if (!text.includes('@theme inline')) missing.push('@theme inline mention');
	if (!text.includes('public/r/style.json'))
		missing.push('public/r/style.json token source');
	return missing;
}

describe('ADR-0065 supersession and item 13 amendment', () => {
	test('ADR-0065 carries the supersession note with the measurement', () => {
		const text = readFileSync(
			join(import.meta.dir, '../..', ADR_0065_PATH),
			'utf8',
		);
		expect(missingAdrRequirements(text)).toEqual([]);
	});

	test('memory item 13 carries the 2026-08-14 amendment with the measurement', () => {
		const text = readFileSync(
			join(import.meta.dir, '../..', MEMORY_PATH),
			'utf8',
		);
		expect(missingMemoryRequirements(text)).toEqual([]);
	});

	test('the checkers reject text lacking the sentences (not tautological)', () => {
		const bare = '# doc\nNothing about supersession here.';
		expect(missingAdrRequirements(bare)).toHaveLength(4);
		expect(missingMemoryRequirements(bare)).toHaveLength(4);
	});

	test('the checkers stay red against plausible fabricated prose without the measurement', () => {
		const fabricated = [
			'Nota de supersessao: o ADR-0069 supersede a parte de tokens deste ADR.',
			'Emenda de 2026-08-14: o escopo foi convertido de [data-coss-root] para :root por preferencia de simplicidade da nossa camada.',
		].join('\n');
		expect(missingAdrRequirements(fabricated)).not.toHaveLength(0);
		expect(missingMemoryRequirements(fabricated)).not.toHaveLength(0);
	});
});
