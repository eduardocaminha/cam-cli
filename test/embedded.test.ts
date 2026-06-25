// test/embedded.test.ts
//
// US-011 acceptance criterion 4: `./dist/cam-darwin-arm64 init` runs the
// validator without erroring. The hard part of "without erroring" in a
// compiled binary is making sure the embedded vendor files
// (`vendor/cam-loop.local.md.tmpl` plus the smoke `.ts`/`.sh` files used
// by `cam init`) are reachable at runtime.
//
// Because we use a codegen step (`scripts/generate-embedded-vendor.ts`)
// rather than runtime reads, the in-process `readEmbedded()` API behaves
// identically in dev and compiled modes — both branches read from the same
// inlined string constants in `src/vendor/_generated.ts`. So testing dev
// mode here is sufficient; the compiled-binary equivalent is exercised once
// at release time via `scripts/build-release.sh` (which runs
// `./dist/cam-darwin-arm64 init` against a tmp config).
//
// What we cover:
//   1. The codegen output is byte-for-byte identical to the on-disk vendor
//      files. Catches a stale `_generated.ts` that wasn't re-run after a
//      vendor edit.
//   2. `readEmbedded()` returns the contents for every key in the union.
//   3. `materializeEmbedded()` extracts to a tempdir and is idempotent;
//      a re-call doesn't rewrite the file (same size → reuse).
//   4. The materialized file's contents match the embedded contents.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
	EMBEDDED_CONTENTS,
	materializeEmbedded,
	readEmbedded,
	type EmbeddedKey,
} from '../src/vendor/embedded.ts';
import { materializeTemplates, templatesContents } from '../src/templates/embedded.ts';

const VENDOR_KEYS: readonly EmbeddedKey[] = [
	'cam-loop.local.md.tmpl',
	'check-agent-frontmatter.ts',
	'check-agent-frontmatter.sh',
];

const VENDOR_DIR = resolve(import.meta.dir, '..', 'vendor');

describe('EMBEDDED_CONTENTS — codegen byte-parity', () => {
	for (const key of VENDOR_KEYS) {
		test(`${key} matches vendor/${key} byte-for-byte`, () => {
			const fromCodegen = EMBEDDED_CONTENTS[key];
			const fromDisk = readFileSync(join(VENDOR_DIR, key), 'utf8');
			expect(fromCodegen).toBe(fromDisk);
		});
	}

	test('contains exactly the three embedded files (US-011 originals; stop hook dropped in CAM-3)', () => {
		// If you add an embedded asset, update this list AND the
		// `VENDOR_KEYS` array above. Locking the set down here catches a
		// stray entry that would bloat the binary without intent.
		expect(Object.keys(EMBEDDED_CONTENTS).sort()).toEqual([
			'cam-loop.local.md.tmpl',
			'check-agent-frontmatter.sh',
			'check-agent-frontmatter.ts',
		]);
	});
});

describe('readEmbedded', () => {
	test('returns the template body byte-for-byte', () => {
		const fromEmbedded = readEmbedded('cam-loop.local.md.tmpl');
		const fromDisk = readFileSync(join(VENDOR_DIR, 'cam-loop.local.md.tmpl'), 'utf8');
		expect(fromEmbedded).toBe(fromDisk);
		// Spot-check the placeholder grammar so a sloppy template edit
		// (renaming `{{MAX_ITERATIONS}}` to something `next.ts` doesn't
		// substitute) is caught here, not at first compiled-binary run.
		expect(fromEmbedded).toContain('{{MAX_ITERATIONS}}');
		expect(fromEmbedded).toContain('{{COMPLETION_PROMISE_YAML}}');
		expect(fromEmbedded).toContain('{{PROMPT}}');
	});

	test('returns non-empty contents for every key', () => {
		for (const key of VENDOR_KEYS) {
			const contents = readEmbedded(key);
			expect(contents.length).toBeGreaterThan(0);
		}
	});
});

describe('templatesContents — codegen byte-parity', () => {
	test('matches every file under templates/ byte-for-byte', () => {
		const TEMPLATES_DIR = resolve(import.meta.dir, '..', 'templates');
		// Walk templates/ on disk and compare to the codegen map.
		const walk = (root: string, base = ''): string[] => {
			const out: string[] = [];
			for (const entry of readdirSync(join(root, base))) {
				const rel = base ? `${base}/${entry}` : entry;
				const abs = join(root, rel);
				if (statSync(abs).isDirectory()) out.push(...walk(root, rel));
				else out.push(rel);
			}
			return out.sort();
		};
		const onDisk = walk(TEMPLATES_DIR);
		const fromCodegen = Object.keys(templatesContents).sort();
		expect(fromCodegen).toEqual(onDisk);
		for (const rel of onDisk) {
			expect(templatesContents[rel]).toBe(readFileSync(join(TEMPLATES_DIR, rel), 'utf8'));
		}
	});
});

describe('templatesContents — oracle contract in planner prompt (US-001)', () => {
	// The planner agent at templates/agents/subagent-planner.md must document
	// the oracle contract so every generated PRD has mechanically-checkable
	// acceptance criteria. Spec drift (a criterion that cannot be verified) is
	// the #1 failure mode identified in the two-layer-verification research.

	const planner = templatesContents['agents/subagent-planner.md'];

	test('contains the oracle litmus quote', () => {
		expect(planner).toContain("if you can't test whether the spec was followed, it's too vague");
	});

	test('names all three oracle kinds: named-command, file-assert, reviewer-judgment', () => {
		expect(planner).toContain('named-command');
		expect(planner).toContain('file-assert');
		expect(planner).toContain('reviewer-judgment');
	});
});

describe('templatesContents — oracle enforcement in auditor prompt (US-002)', () => {
	// The auditor at templates/agents/subagent-auditor.md must BLOCK (not soft-note)
	// on any acceptanceCriterion that lacks an oracle. Spec: C9 upgraded from
	// "verifiable" to "has an oracle" with explicit BLOCK verb and all three oracle kinds.

	const auditor = templatesContents['agents/subagent-auditor.md'];

	test('contains the oracle requirement phrase', () => {
		expect(auditor).toContain('has an oracle');
	});

	test('names all three oracle kinds: named-command, file-assert, reviewer-judgment', () => {
		expect(auditor).toContain('named-command');
		expect(auditor).toContain('file-assert');
		expect(auditor).toContain('reviewer-judgment');
	});

	test('contains the BLOCK verb for oracle-free criterion finding', () => {
		expect(auditor).toContain('BLOCK');
	});
});

describe('materializeTemplates — .gitignore is merged, never clobbered', () => {
	// CAM-55 round-2 review: `templates/.gitignore` lands at the project root.
	// A blind overwrite would destroy a downstream project's existing
	// .gitignore (silent data loss). These cover the merge contract.
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), 'cam-templates-test-'));
	});

	afterEach(() => {
		if (cwd && existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
	});

	const camPattern = 'scripts/cam/worker-report.json';
	const gitignorePath = () => join(cwd, '.gitignore');

	test('creates .gitignore (verbatim) when the project has none', () => {
		materializeTemplates(cwd);
		expect(existsSync(gitignorePath())).toBe(true);
		// Template as `expected` (received accepts unknown; expected must be string).
		expect(templatesContents['.gitignore']).toBe(readFileSync(gitignorePath(), 'utf8'));
	});

	test('preserves an existing .gitignore and appends the cam pattern', () => {
		const userContent = 'node_modules\ndist\n.env\n';
		writeFileSync(gitignorePath(), userContent, 'utf8');
		materializeTemplates(cwd);
		const merged = readFileSync(gitignorePath(), 'utf8');
		// Every user line survives.
		expect(merged).toContain('node_modules');
		expect(merged).toContain('dist');
		expect(merged).toContain('.env');
		// The cam pattern is appended.
		expect(merged).toContain(camPattern);
		// It was an APPEND, not a clobber: user content is the prefix.
		expect(merged.startsWith(userContent)).toBe(true);
	});

	test('is idempotent — a re-run does not duplicate the cam pattern', () => {
		writeFileSync(gitignorePath(), 'node_modules\n', 'utf8');
		materializeTemplates(cwd);
		const once = readFileSync(gitignorePath(), 'utf8');
		materializeTemplates(cwd);
		const twice = readFileSync(gitignorePath(), 'utf8');
		expect(twice).toBe(once);
		// Exactly one occurrence of the pattern.
		expect(twice.split(camPattern).length - 1).toBe(1);
	});

	test('handles an existing .gitignore with no trailing newline', () => {
		writeFileSync(gitignorePath(), 'node_modules', 'utf8'); // no trailing \n
		materializeTemplates(cwd);
		const merged = readFileSync(gitignorePath(), 'utf8');
		// The appended pattern is on its own line, not glued to node_modules.
		expect(merged).toContain('node_modules\n');
		expect(merged).toContain(camPattern);
		expect(merged).not.toContain(`node_modules${camPattern}`);
	});
});

describe('templatesContents — gate discipline in implementer prompt (US-003)', () => {
	// The implementer agent at templates/agents/subagent-implementer.md must
	// document the gate-discipline rules so every future worker knows:
	//   (a) it is PROHIBITED from declaring done before gates pass,
	//   (b) a gate is a named-command + exitCode 0 (not prose),
	//   (c) the roll-up uses success/partial/failure labels.

	const implementer = templatesContents['agents/subagent-implementer.md'];

	test('contains the PROHIBITED phrase', () => {
		expect(implementer).toContain('PROHIBITED');
	});

	test('contains the named-command + exitCode 0 gate definition', () => {
		expect(implementer).toContain('named-command + exitCode 0');
	});

	test('contains the success/partial/failure roll-up labels', () => {
		expect(implementer).toContain('success');
		expect(implementer).toContain('partial');
		expect(implementer).toContain('failure');
	});
});

describe('templatesContents — Layer B binary rubric in reviewer prompt (US-004)', () => {
	// The reviewer agent at templates/agents/subagent-reviewer.md must deliver a
	// binary PASS/FAIL verdict on a fixed 8-criterion rubric, walking criterion-
	// by-criterion with per-criterion evidence, explicitly NOT trusting a green
	// test suite, and hard-failing the entire verdict on any hard-constraint breach.

	const reviewer = templatesContents['agents/subagent-reviewer.md'];

	test('contains all 8 rubric criterion names verbatim', () => {
		expect(reviewer).toContain('spec-correctness');
		expect(reviewer).toContain('tests-with-meaningful-assert');
		expect(reviewer).toContain('strict-types');
		expect(reviewer).toContain('error-handling');
		expect(reviewer).toContain('project-conventions');
		expect(reviewer).toContain('security');
		expect(reviewer).toContain('deps');
		expect(reviewer).toContain('perf');
	});

	test('contains the evidence-per-criterion instruction', () => {
		expect(reviewer).toContain('evidence per criterion');
	});

	test('contains the does-not-trust-green-tests clause', () => {
		expect(reviewer).toContain('does not trust green tests');
	});

	test('contains the hard-constraint-fail-the-whole rule', () => {
		expect(reviewer).toContain('hard-constraint');
	});
});

describe('templatesContents — none/create uses --file-local in cam-issue prompt (US-004)', () => {
	// US-004: the none create subcommand must invoke cam issue --file-local
	// (commits to main without touching the work branch) instead of the old
	// direct-edit path ("write the file back"). Both copies (templates/ and
	// .claude/commands/) must carry this instruction.

	const camIssue = templatesContents['commands/cam-issue.md'] ?? '';

	test('contains cam issue --file-local invocation', () => {
		expect(camIssue).toContain('cam issue --file-local');
	});

	test('does not contain the old hand-edit instruction', () => {
		expect(camIssue).not.toContain('write the file back');
	});

	test('contains the CONVENTION note about never hand-editing on a feature branch', () => {
		expect(camIssue).toContain('never hand-edit issues.local.json on a feature branch');
	});
});

describe('CAM-68: harness runtime marker ignore rules', () => {
	// CAM-68 added 7 runtime-marker rules to templates/.gitignore so that
	// orchestrator / setup / handoff / sidecar files are never accidentally
	// committed. These tests pin all 7 rules in the embedded templates map and
	// guard against the orchestrator-prompt file being re-tracked.

	const gitignore = templatesContents['.gitignore'] ?? '';

	const MARKER_RULES = [
		'.cam-orchestrator-prompt.txt',
		'.cam-setup-menu.sh',
		'.cam-setup-prompt.txt',
		'.cam-orch-ready',
		'.cam-sidecar.pid',
		'.cam-orch-handoff.json',
		'.cam-orch-handoff.consumed.json',
	] as const;

	for (const rule of MARKER_RULES) {
		test(`embedded .gitignore contains rule for ${rule}`, () => {
			expect(gitignore).toContain(rule);
		});
	}

	test('orchestrator-prompt file is NOT tracked by git (re-tracking regression guard)', () => {
		// git ls-files --error-unmatch exits 1 when the file is absent from
		// the index (either untracked or gitignored). We assert NON-ZERO so
		// this test breaks loudly if the file ever gets accidentally re-added.
		const r = Bun.spawnSync([
			'git',
			'ls-files',
			'--error-unmatch',
			'.claude/.cam-orchestrator-prompt.txt',
		]);
		expect(r.exitCode).not.toBe(0);
	});
});

describe('templatesContents — lastCompletedStory object shape in implementer prompt (CAM-58 US-002)', () => {
	// The implementer prompt must instruct writing lastCompletedStory as a JSON
	// object {id, title}, not a bare string. US-001 coercion is a defensive net;
	// the happy path should always emit the schema-compliant object form.

	const implementer = templatesContents['agents/subagent-implementer.md'];

	test('contains the object form for lastCompletedStory', () => {
		expect(implementer).toContain('"lastCompletedStory": {');
	});

	test('does not contain the bare-string form for lastCompletedStory', () => {
		expect(implementer).not.toMatch(/"lastCompletedStory"\s*:\s*"US-/);
	});
});

describe('materializeEmbedded', () => {
	let cacheDir: string;
	let prevCache: string | undefined;

	beforeEach(() => {
		cacheDir = mkdtempSync(join(tmpdir(), 'cam-embedded-test-'));
		prevCache = process.env['CAM_VENDOR_CACHE_DIR'];
		process.env['CAM_VENDOR_CACHE_DIR'] = cacheDir;
	});

	afterEach(() => {
		if (prevCache === undefined) {
			delete process.env['CAM_VENDOR_CACHE_DIR'];
		} else {
			process.env['CAM_VENDOR_CACHE_DIR'] = prevCache;
		}
		if (cacheDir && existsSync(cacheDir)) {
			rmSync(cacheDir, { recursive: true, force: true });
		}
	});

	test('writes the embedded contents to the cache dir', () => {
		const path = materializeEmbedded('check-agent-frontmatter.ts');
		expect(existsSync(path)).toBe(true);
		expect(path).toBe(join(cacheDir, 'check-agent-frontmatter.ts'));
		expect(readFileSync(path, 'utf8')).toBe(readEmbedded('check-agent-frontmatter.ts'));
	});

	test('is idempotent — same path on a repeat call', () => {
		const a = materializeEmbedded('check-agent-frontmatter.ts');
		const b = materializeEmbedded('check-agent-frontmatter.ts');
		expect(a).toBe(b);
	});

	test('reuses the cached file when sizes match (no re-extract)', () => {
		const path = materializeEmbedded('check-agent-frontmatter.ts');
		const mtimeBefore = statSync(path).mtimeMs;
		// Wait a tick so a re-extract would visibly bump mtime.
		const start = Date.now();
		while (Date.now() - start < 5) {
			// busy-wait
		}
		materializeEmbedded('check-agent-frontmatter.ts');
		const mtimeAfter = statSync(path).mtimeMs;
		expect(mtimeAfter).toBe(mtimeBefore);
	});

	test('re-extracts when the cached file has been corrupted (size mismatch)', () => {
		const path = materializeEmbedded('check-agent-frontmatter.ts');
		writeFileSync(path, 'corrupted', 'utf8');
		const re = materializeEmbedded('check-agent-frontmatter.ts');
		expect(re).toBe(path);
		expect(readFileSync(re, 'utf8')).toBe(readEmbedded('check-agent-frontmatter.ts'));
	});

	test('materializes every key without error', () => {
		for (const key of VENDOR_KEYS) {
			const path = materializeEmbedded(key);
			expect(existsSync(path)).toBe(true);
			expect(readFileSync(path, 'utf8')).toBe(readEmbedded(key));
		}
	});
});
