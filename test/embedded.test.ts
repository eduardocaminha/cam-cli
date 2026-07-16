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

	test('documents the absence/presence grep idiom (US-001)', () => {
		expect(planner).toContain('! grep -q PATTERN file');
		expect(planner).toContain('grep -q PATTERN file');
		expect(planner).toContain('self-nullifying');
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

	test('BLOCKs on the grep -q + -L/-l self-nullifying oracle antipattern and names the ! grep -q replacement (US-002, CAM-309)', () => {
		expect(auditor).toContain('self-nullifying');
		expect(auditor).toContain('-Lq');
		expect(auditor).toContain('-qL');
		expect(auditor).toContain('! grep -q PATTERN file');
	});
});

describe('templatesContents — merit-over-cost clause in surviving copies (CAM-145 US-002)', () => {
	// The merit-over-cost clause ('engineering merit') was inserted by US-001 into
	// 3 surfaces. US-005 (CAM-151) intentionally reduced commands/cam-plan.md to a
	// thin phase-signal stub, removing the old Step 6 scope-proposal text where the
	// clause lived. The assertion for cam-plan.md is dropped; the other two surfaces
	// still carry the clause and are checked here.

	test('grill-with-docs/SKILL.md embedded copy contains the clause', () => {
		const content = templatesContents['skills/grill-with-docs/SKILL.md'] ?? '';
		expect(content).toContain('engineering merit');
	});

	test('agents/subagent-orchestrator.md embedded copy contains the clause', () => {
		const content = templatesContents['agents/subagent-orchestrator.md'] ?? '';
		expect(content).toContain('engineering merit');
	});
});

describe('templatesContents — circuit-broken blocker line (CAM-214 US-004)', () => {
	test('agents/subagent-orchestrator.md embedded copy surfaces the circuit-broken line', () => {
		const content = templatesContents['agents/subagent-orchestrator.md'] ?? '';
		expect(content).toContain('circuit-broken');
		expect(content).toContain('Do NOT delete the marker');
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
		expect(camIssue).toContain('never hand-edit issue files on a feature branch');
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
		'.cam-orch-pid',
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

describe('templatesContents — settings.json + hook key presence guard (US-004)', () => {
	// A future regen must not silently drop the settings.json or the
	// hook-script key. These assertions make the drop a hard test failure.

	test('contains the .claude/settings.json key', () => {
		expect(templatesContents['.claude/settings.json']).toBeDefined();
		expect((templatesContents['.claude/settings.json'] ?? '').length).toBeGreaterThan(0);
	});

	test('contains the .claude/hooks/orch-agent-allowlist.sh key', () => {
		expect(templatesContents['.claude/hooks/orch-agent-allowlist.sh']).toBeDefined();
		expect((templatesContents['.claude/hooks/orch-agent-allowlist.sh'] ?? '').length).toBeGreaterThan(0);
	});

	test('.claude/settings.json content registers the orch-agent-allowlist.sh hook', () => {
		const content = templatesContents['.claude/settings.json'] ?? '';
		expect(content).toContain('orch-agent-allowlist.sh');
		expect(content).toContain('PreToolUse');
	});
});

describe('templatesContents — jq fail-closed guard in orch-agent-allowlist.sh (US-002)', () => {
	// US-002 acceptance criterion: the embedded template hook must contain the
	// `command -v jq` fail-closed guard so a future regen that drops it fails
	// this test. Without the guard, a missing jq exits 127 (fail-open). With
	// it, the hook emits a static deny JSON via printf and exits 0 (fail-closed).

	const hook = templatesContents['.claude/hooks/orch-agent-allowlist.sh'] ?? '';

	test('contains the command -v jq fail-closed guard', () => {
		expect(hook).toContain('command -v jq');
	});

	test('contains the static printf deny for jq-absent path', () => {
		expect(hook).toContain('jq is absent');
	});
});

describe('materializeTemplates — hook is executable after materialization (US-004)', () => {
	// writeFileSync does not preserve the source mode bit. materializeTemplates
	// must chmod +x any file under .claude/hooks/ so the hook is runnable by
	// the Claude Code hooks runtime.

	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), 'cam-hook-exec-test-'));
	});

	afterEach(() => {
		if (cwd && existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
	});

	test('materialized orch-agent-allowlist.sh has the owner-exec bit set', () => {
		materializeTemplates(cwd);
		const hookPath = join(cwd, '.claude', 'hooks', 'orch-agent-allowlist.sh');
		expect(existsSync(hookPath)).toBe(true);
		const mode = statSync(hookPath).mode;
		// owner-exec bit = 0o100 (S_IXUSR)
		expect(mode & 0o100).toBe(0o100);
	});

	test('materialized .claude/settings.json exists and contains the hook command', () => {
		materializeTemplates(cwd);
		const settingsPath = join(cwd, '.claude', 'settings.json');
		expect(existsSync(settingsPath)).toBe(true);
		const content = readFileSync(settingsPath, 'utf8');
		expect(content).toContain('orch-agent-allowlist.sh');
	});
});

describe('materializeTemplates — skills/ subtree routing + count', () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), 'cam-skills-test-'));
	});

	afterEach(() => {
		if (cwd && existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
	});

	test('5 known skill files exist under .claude/skills/', () => {
		materializeTemplates(cwd);
		expect(existsSync(join(cwd, '.claude', 'skills', 'domain-modeling', 'SKILL.md'))).toBe(true);
		expect(
			existsSync(join(cwd, '.claude', 'skills', 'domain-modeling', 'CONTEXT-FORMAT.md')),
		).toBe(true);
		expect(existsSync(join(cwd, '.claude', 'skills', 'domain-modeling', 'ADR-FORMAT.md'))).toBe(
			true,
		);
		expect(existsSync(join(cwd, '.claude', 'skills', 'grill-with-docs', 'SKILL.md'))).toBe(true);
		expect(existsSync(join(cwd, '.claude', 'skills', 'grilling', 'SKILL.md'))).toBe(true);
	});

	test('no skill file is written to the legacy <cwd>/skills/ location', () => {
		materializeTemplates(cwd);
		expect(existsSync(join(cwd, 'skills'))).toBe(false);
	});

	test('per-subtree count map includes skills key equal to 5', () => {
		const counts = materializeTemplates(cwd);
		expect(counts.skills).toBe(5);
	});
});

describe('materializeTemplates — patterns.md stub + orch-handoff.schema.json seeds (US-002)', () => {
	// A fresh downstream project must be born with scripts/cam/patterns.md
	// (a stub, not cam-cli's live 600-line file) and
	// scripts/cam/orch-handoff.schema.json (parity with the already-seeded
	// handoff.schema.json).
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), 'cam-seeds-test-'));
	});

	afterEach(() => {
		if (cwd && existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
	});

	test('writes scripts/cam/patterns.md as a stub (under 30 lines, has the header)', () => {
		materializeTemplates(cwd);
		const dst = join(cwd, 'scripts', 'cam', 'patterns.md');
		expect(existsSync(dst)).toBe(true);
		const content = readFileSync(dst, 'utf8');
		expect(content).toContain('# Codebase Patterns');
		expect(content.split('\n').length).toBeLessThan(30);
	});

	test('writes scripts/cam/orch-handoff.schema.json matching the embedded template byte-for-byte', () => {
		materializeTemplates(cwd);
		const dst = join(cwd, 'scripts', 'cam', 'orch-handoff.schema.json');
		expect(existsSync(dst)).toBe(true);
		expect(readFileSync(dst, 'utf8')).toBe(
			templatesContents['scripts/cam/orch-handoff.schema.json'] ?? '',
		);
	});
});

describe('CAM-119: cam init installs the grill-with-docs skill chain downstream', () => {
	// Regression guard: asserts that materializeTemplates (the install routine
	// exercised by `cam init`) writes the grill-with-docs skill chain and every
	// embedded skills/* file under .claude/skills/, and that the cam-spec
	// command ships together with its grill-with-docs skill dependency. Prevents
	// the skill-not-found-downstream failure (cam-spec invokes a skill that was
	// never installed) from silently reappearing.
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), 'cam-skills-regress-'));
	});

	afterEach(() => {
		if (cwd && existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
	});

	test('grill-with-docs/SKILL.md is installed and matches embedded byte-for-byte', () => {
		materializeTemplates(cwd);
		const installed = readFileSync(
			join(cwd, '.claude', 'skills', 'grill-with-docs', 'SKILL.md'),
			'utf8',
		);
		const embedded = templatesContents['skills/grill-with-docs/SKILL.md'] ?? '';
		expect(embedded).toBeTruthy();
		expect(installed).toBe(embedded);
	});

	test('full domain-modeling skill set lands under .claude/skills/ byte-for-byte', () => {
		materializeTemplates(cwd);
		const dmBase = join(cwd, '.claude', 'skills', 'domain-modeling');
		const names = ['SKILL.md', 'CONTEXT-FORMAT.md', 'ADR-FORMAT.md'] as const;
		for (const name of names) {
			expect(existsSync(join(dmBase, name))).toBe(true);
			const installed = readFileSync(join(dmBase, name), 'utf8');
			const embedded = templatesContents[`skills/domain-modeling/${name}`] ?? '';
			expect(embedded).toBeTruthy();
			expect(installed).toBe(embedded);
		}
	});

	test('grilling/SKILL.md is installed and matches embedded byte-for-byte', () => {
		materializeTemplates(cwd);
		const installed = readFileSync(
			join(cwd, '.claude', 'skills', 'grilling', 'SKILL.md'),
			'utf8',
		);
		const embedded = templatesContents['skills/grilling/SKILL.md'] ?? '';
		expect(embedded).toBeTruthy();
		expect(installed).toBe(embedded);
	});

	test('cam-spec.md references grill-with-docs AND the skill is co-installed', () => {
		materializeTemplates(cwd);
		// The embedded command template references the skill.
		const camSpecEmbedded = templatesContents['commands/cam-spec.md'] ?? '';
		expect(camSpecEmbedded).toContain('grill-with-docs');
		// The materialized command under .claude/commands/ also references it.
		const installedSpec = readFileSync(
			join(cwd, '.claude', 'commands', 'cam-spec.md'),
			'utf8',
		);
		expect(installedSpec).toContain('grill-with-docs');
		// The skill dependency is co-installed under .claude/skills/.
		expect(
			existsSync(join(cwd, '.claude', 'skills', 'grill-with-docs', 'SKILL.md')),
		).toBe(true);
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
