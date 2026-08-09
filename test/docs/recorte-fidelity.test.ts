// test/docs/recorte-fidelity.test.ts
//
// US-008 (CAM-516): the `claude -p` prohibition recorte prose in
// scripts/cam/CLAUDE.md must be checked for FIDELITY against ADR-0059, not
// merely for token presence. `grep -q` proves a word exists; it proves
// nothing about whether the surrounding claim is true (see
// scripts/cam/patterns.md, "Evidence fidelity is its own species", CAM-439).
//
// This file extracts the recorte paragraph, extracts its measured claims
// (date, apiKeySource value, rate_limit_event window, host/config-dir scope,
// unchanged console consumption), and cross-checks each one against the
// literal ADR-0059 text. A `fabricated` test proves the checker actually
// rejects plausible invented prose, not just tautologically accepts whatever
// is on branch HEAD.

import { test, expect, describe } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestTmpdir } from '../helpers/test-tmpdir';

const CLAUDE_MD_PATH = join(import.meta.dir, '../../scripts/cam/CLAUDE.md');
const ADR_PATH = join(
	import.meta.dir,
	'../../docs/adr/0059-execucao-headless-do-worker-a-proibicao-de-2026-06-e-recortada-nao-aposentada.md',
);

const RECORTE_MARKER = '**Recorte of the `claude -p` prohibition';

/** Pulls the single recorte paragraph (one markdown "line item") out of CLAUDE.md. */
function extractRecorteParagraph(claudeMd: string): string {
	const line = claudeMd.split('\n').find((l) => l.startsWith(RECORTE_MARKER));
	if (line === undefined) {
		throw new Error(`recorte paragraph (starting "${RECORTE_MARKER}") not found in scripts/cam/CLAUDE.md`);
	}
	return line;
}

interface FidelityResult {
	valid: boolean;
	failures: string[];
}

/**
 * Checks that every measured claim asserted by the recorte paragraph is
 * corroborated, near-verbatim, by the ADR-0059 text: the measurement date,
 * the unchanged console consumption, the reported apiKeySource value, the
 * rate_limit_event's seven-day window, and the host + config-dir scope. Also
 * guards against the paragraph asserting the container+env-token combination
 * WAS measured, which ADR-0059 explicitly records as unmeasured.
 */
function checkRecorteFidelity(paragraph: string, adrText: string): FidelityResult {
	const failures: string[] = [];

	// Claim 1: the measurement date.
	const dateMatch = paragraph.match(/\b(\d{4}-\d{2}-\d{2})\b/);
	if (dateMatch === null) {
		failures.push('paragraph does not assert a measurement date');
	} else if (!adrText.includes(dateMatch[1] as string)) {
		failures.push(`date claim "${dateMatch[1]}" is not present in ADR-0059`);
	}

	// Claim 2: console API consumption stayed unchanged.
	const CONSUMPTION_PHRASE = 'consumo de API inalterado';
	if (!paragraph.includes(CONSUMPTION_PHRASE)) {
		failures.push(`paragraph does not assert "${CONSUMPTION_PHRASE}"`);
	} else if (!adrText.includes(CONSUMPTION_PHRASE)) {
		failures.push(`"${CONSUMPTION_PHRASE}" claim is not present in ADR-0059`);
	}

	// Claim 3: the reported apiKeySource value.
	const apiKeyMatch = paragraph.match(/apiKeySource\s+`?(none|user|project|unknown)`?/i);
	if (apiKeyMatch === null) {
		failures.push('paragraph does not assert a reported apiKeySource value');
	} else {
		const value = apiKeyMatch[1] as string;
		const adrApiKeyRe = new RegExp(`apiKeySource\\s+${value}`, 'i');
		if (!adrApiKeyRe.test(adrText)) {
			failures.push(`apiKeySource value "${value}" is not corroborated by ADR-0059`);
		}
	}

	// Claim 4: rate_limit_event with a seven-day ("sete dias") subscription window.
	const SEVEN_DAY_PHRASE = 'sete dias';
	const paragraphLower = paragraph.toLowerCase();
	if (!paragraph.includes('rate_limit_event') || !paragraphLower.includes(SEVEN_DAY_PHRASE)) {
		failures.push(`paragraph does not assert "rate_limit_event" with a "${SEVEN_DAY_PHRASE}" (seven-day) window`);
	} else if (!adrText.includes('rate_limit_event') || !adrText.toLowerCase().includes(SEVEN_DAY_PHRASE)) {
		failures.push(`"rate_limit_event" / "${SEVEN_DAY_PHRASE}" claim is not present in ADR-0059`);
	}

	// Claim 5: host + config-dir scope of the measurement.
	const HOST_SCOPE_PHRASE = 'rodando no host e autenticando pelo diretorio de configuracao';
	if (!paragraph.includes(HOST_SCOPE_PHRASE)) {
		failures.push(`paragraph does not assert "${HOST_SCOPE_PHRASE}" (host + config-dir scope)`);
	} else if (!adrText.includes(HOST_SCOPE_PHRASE)) {
		failures.push(`"${HOST_SCOPE_PHRASE}" claim is not present in ADR-0059`);
	}

	// Negative guard: the paragraph must NOT assert the container+env-token
	// combination WAS measured — ADR-0059 explicitly records it as unmeasured.
	const containerIdx = paragraphLower.indexOf('container');
	if (containerIdx !== -1) {
		const window = paragraphLower.slice(containerIdx, containerIdx + 160);
		const negated = /(not measured|unmeasured|nao foi medid)/.test(window);
		const assertsMeasured = /\bmeasured\b/.test(window) && !negated;
		if (assertsMeasured) {
			failures.push(
				'paragraph asserts the container+env-token combination was measured, but ADR-0059 records it as unmeasured',
			);
		}
	}

	return { valid: failures.length === 0, failures };
}

function readClaudeMd(): string {
	return readFileSync(CLAUDE_MD_PATH, 'utf8');
}

function readAdr(): string {
	return readFileSync(ADR_PATH, 'utf8');
}

describe('recorte fidelity', () => {
	test('the recorte paragraph exists in scripts/cam/CLAUDE.md', () => {
		const paragraph = extractRecorteParagraph(readClaudeMd());
		expect(paragraph.length).toBeGreaterThan(0);
	});

	test('every measured claim in the recorte paragraph is corroborated by ADR-0059', () => {
		const paragraph = extractRecorteParagraph(readClaudeMd());
		const adrText = readAdr();

		const result = checkRecorteFidelity(paragraph, adrText);

		expect(result.failures).toEqual([]);
		expect(result.valid).toBe(true);
	});

	test('fabricated: the checker rejects a plausible but invented justification', () => {
		const paragraph = extractRecorteParagraph(readClaudeMd());
		const adrText = readAdr();

		// A fabricated variant that swaps the measured apiKeySource value for a
		// different, equally plausible-sounding one that ADR-0059 never records.
		const fabricated = paragraph.replace('apiKeySource none', 'apiKeySource user');
		expect(fabricated).not.toBe(paragraph);

		const genuineResult = checkRecorteFidelity(paragraph, adrText);
		expect(genuineResult.valid).toBe(true);

		const fabricatedResult = checkRecorteFidelity(fabricated, adrText);
		expect(fabricatedResult.valid).toBe(false);
		expect(fabricatedResult.failures.some((f) => f.includes('apiKeySource'))).toBe(true);
	});

	test('fabricated: a tmpdir copy of the recorte paragraph with an invented date is rejected', () => {
		const paragraph = extractRecorteParagraph(readClaudeMd());
		const adrText = readAdr();

		// A fabricated variant materialized on disk (a tmpdir copy), swapping the
		// measured 2026-08-08 date for a different, plausible-sounding date that
		// ADR-0059 never records.
		const dateMatch = paragraph.match(/\b\d{4}-\d{2}-\d{2}\b/);
		expect(dateMatch).not.toBeNull();
		const genuineDate = dateMatch?.[0] as string;
		const fabricatedDate = genuineDate === '2026-08-01' ? '2026-08-02' : '2026-08-01';
		const fabricated = paragraph.replaceAll(genuineDate, fabricatedDate);
		expect(fabricated).not.toBe(paragraph);

		const dir = createTestTmpdir('recorte-fidelity-');
		const fabricatedPath = join(dir, 'fabricated-recorte.md');
		writeFileSync(fabricatedPath, fabricated, 'utf8');
		const onDisk = readFileSync(fabricatedPath, 'utf8');

		const result = checkRecorteFidelity(onDisk, adrText);
		expect(result.valid).toBe(false);
		expect(result.failures.some((f) => f.includes(fabricatedDate))).toBe(true);
	});
});
