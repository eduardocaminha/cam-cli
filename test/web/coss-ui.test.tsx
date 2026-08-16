// test/web/coss-ui.test.tsx
//
// The vendored COSS tree is a pinned, copy-owned snapshot: five files and a
// provenance record, nothing else. This file pins that shape, pins the licence
// evidence, pins the npm versions the pinned commit declares, and runs the
// fail-closed import guard over the real tree. The components themselves are
// executed (not regex-matched) through static rendering, per ADR-0067.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { runCli, verify } from '../../scripts/vendor-coss.ts';
import { Badge } from '../../webui/vendor/coss/ui/badge.tsx';
import { Card, CardPanel, CardTitle } from '../../webui/vendor/coss/ui/card.tsx';
import { cn } from '../../webui/vendor/coss/lib/utils.ts';
import {
	Progress,
	ProgressIndicator,
	ProgressTrack,
} from '../../webui/vendor/coss/ui/progress.tsx';
import { Separator } from '../../webui/vendor/coss/ui/separator.tsx';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const VENDOR_ROOT = join(REPO_ROOT, 'webui', 'vendor', 'coss');
const PINNED_SHA = 'e43fa4a8da4c490ebf3e1e1707b2a9af6fa2a217';

/** Every file under the vendored root, repo-relative to it, sorted. */
function vendorFiles(dir: string = VENDOR_ROOT): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...vendorFiles(path));
		else found.push(relative(VENDOR_ROOT, path));
	}
	return found.sort();
}

describe('vendored COSS tree', () => {
	test('holds exactly the four components, the cn helper and the provenance record', () => {
		expect(vendorFiles()).toEqual([
			'PROVENANCE.md',
			'lib/utils.ts',
			'ui/badge.tsx',
			'ui/card.tsx',
			'ui/progress.tsx',
			'ui/separator.tsx',
		]);
	});

	test('records the pinned commit, the MIT scope and the upstream licence text', () => {
		const provenance = readFileSync(join(VENDOR_ROOT, 'PROVENANCE.md'), 'utf8');

		expect(provenance).toContain(PINNED_SHA);
		expect(provenance).toContain('apps/ui/registry/default/ui/card.tsx');
		// ADR-0070: provenance keeps the licence TEXT, not just a pointer to it.
		expect(provenance).toContain('The default license for this project is [AGPLv3.0](LICENSE)');
		expect(provenance).toContain('apps/origin/');
	});

	test('rewrote the upstream alias so no import leaves the verified root', () => {
		const sources = vendorFiles().filter((path) => path !== 'PROVENANCE.md');
		const joined = sources
			.map((path) => readFileSync(join(VENDOR_ROOT, path), 'utf8'))
			.join('\n');

		expect(joined).not.toContain('@/registry/default');
		expect(() => verify(VENDOR_ROOT)).not.toThrow();
		expect(runCli(['--verify', VENDOR_ROOT], () => {})).toBe(0);
	});

	test('declares the four npm dependencies at the versions the pinned commit names', () => {
		const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
			devDependencies?: Record<string, string>;
		};

		expect(manifest.devDependencies).toMatchObject({
			'@base-ui/react': '1.6.0',
			'class-variance-authority': '^0.7.1',
			clsx: '^2.1.1',
			'tailwind-merge': '^3.4.0',
		});
	});
});

describe('vendored COSS components render', () => {
	test('Card, Badge, Progress and Separator each produce their slot markup', () => {
		const html = renderToStaticMarkup(
			<Card>
				<CardTitle>Run</CardTitle>
				<Separator />
				<CardPanel>
					<Badge variant="success">done</Badge>
					<Progress value={60}>
						<ProgressTrack>
							<ProgressIndicator />
						</ProgressTrack>
					</Progress>
				</CardPanel>
			</Card>,
		);

		expect(html).toContain('data-slot="card"');
		expect(html).toContain('data-slot="card-title"');
		expect(html).toContain('data-slot="separator"');
		expect(html).toContain('data-slot="badge"');
		expect(html).toContain('data-slot="progress-track"');
		expect(html).toContain('width:60%');
	});

	test('cn merges conflicting Tailwind utilities last-wins', () => {
		expect(cn('p-2', 'p-4')).toBe('p-4');
		expect(cn('text-sm', false, undefined, 'font-medium')).toBe('text-sm font-medium');
	});
});
