// scripts/ui-snapshot.tsx
//
// Off-screen snapshot dumper for the Ink screens under `src/ui/`. Uses
// `ink-testing-library` to mount each component with controlled props, then
// prints the resulting ASCII frame to stdout so it can be reviewed in chat or
// pinned in `img/ui-snapshot.txt` as a visual reference.
//
// Limitations:
//   - Colors don't render (lastFrame() strips ANSI). To see real colors,
//     run `bun index.ts init` (or another command) in a real TTY.
//   - Spinner frames are not captured — they animate via setInterval; the
//     dumper grabs a single frame, so spinners show one snapshot of `dots`.
//   - Interactive components (Select, SetupScreen) are captured at the state
//     dictated by their prefilled props.
//
// Usage: bun scripts/ui-snapshot.tsx > img/ui-snapshot.txt

import { Box } from 'ink';
import { render } from 'ink-testing-library';

import { InitScreen, type CheckDef, type CheckOutcome } from '../src/ui/InitScreen.tsx';
import { SetupScreen } from '../src/ui/SetupScreen.tsx';
import { Select } from '../src/ui/Select.tsx';
import { Splash } from '../src/ui/Splash.tsx';

const HR = '─'.repeat(72);
const SPLASH_VERSION = '0.1.1';

function section(title: string): void {
	process.stdout.write(`\n${HR}\n  ${title}\n${HR}\n`);
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// Build a check with a description that always renders and an outcome that
// resolves after `runMs`. The shared fixtures below let us point at the same
// label+description across snapshots so the per-row alignment stays stable.
function staticCheck(
	id: string,
	label: string,
	description: string,
	outcome: CheckOutcome,
	runMs = 0,
): CheckDef {
	return {
		id,
		label,
		description,
		run: async () => {
			if (runMs > 0) await delay(runMs);
			return outcome;
		},
	};
}

// Mirror of `buildInteractiveChecks` in src/commands/init.ts so the dumper
// reflects the real check descriptions.
const CHECK_FIXTURES = {
	claude: {
		label: 'claude',
		description: 'Required to spawn Claude Code sessions.',
	},
	frontmatter: {
		label: 'agent-frontmatter',
		description: 'Validates .claude/agents/*.md files.',
	},
	config: {
		label: 'config',
		description: 'Saves your default permission mode.',
	},
} as const;

// `cam init` interactive composes Splash + InitScreen inside a vertical Box
// (see `runInitInteractive` in src/commands/init.ts). Mirror that here so the
// dumper reflects the real on-screen stack.
function renderInitWithSplash(checks: CheckDef[], onDone: (ids: string[]) => void) {
	return render(
		<Box flexDirection="column">
			<Splash version={SPLASH_VERSION} />
			<InitScreen checks={checks} onDone={onDone} />
		</Box>,
	);
}

function snapshotSplash(): void {
	section('Splash — standalone entry panel');
	const { lastFrame, unmount } = render(<Splash version={SPLASH_VERSION} />);
	process.stdout.write(lastFrame() + '\n');
	unmount();
}

async function snapshotInitInitial(): Promise<void> {
	section('cam init — initial mount (Splash + checks pending)');
	const checks: CheckDef[] = [
		// Long delays so nothing resolves before we snapshot.
		staticCheck(
			'claude',
			CHECK_FIXTURES.claude.label,
			CHECK_FIXTURES.claude.description,
			{ status: 'ok', detail: '2.0.5' },
			99_999,
		),
		staticCheck(
			'frontmatter',
			CHECK_FIXTURES.frontmatter.label,
			CHECK_FIXTURES.frontmatter.description,
			{ status: 'ok' },
			99_999,
		),
		staticCheck(
			'config',
			CHECK_FIXTURES.config.label,
			CHECK_FIXTURES.config.description,
			{ status: 'ok', detail: 'written' },
			99_999,
		),
	];
	const { lastFrame, unmount } = renderInitWithSplash(checks, () => {});
	await delay(20); // let initial commit paint
	process.stdout.write(lastFrame() + '\n');
	unmount();
}

async function snapshotInitDoneSuccess(): Promise<void> {
	section('cam init — all checks passed');
	let resolveDone: (() => void) | undefined;
	const donePromise = new Promise<void>((r) => {
		resolveDone = r;
	});
	const checks: CheckDef[] = [
		staticCheck('claude', CHECK_FIXTURES.claude.label, CHECK_FIXTURES.claude.description, {
			status: 'ok',
			detail: '2.0.5',
		}),
		staticCheck(
			'frontmatter',
			CHECK_FIXTURES.frontmatter.label,
			CHECK_FIXTURES.frontmatter.description,
			{ status: 'ok', detail: 'ok' },
		),
		staticCheck('config', CHECK_FIXTURES.config.label, CHECK_FIXTURES.config.description, {
			status: 'ok',
			detail: 'written',
		}),
	];
	const { lastFrame, unmount } = renderInitWithSplash(checks, () => resolveDone?.());
	await donePromise;
	await delay(50);
	process.stdout.write(lastFrame() + '\n');
	unmount();
}

async function snapshotInitDoneFailure(): Promise<void> {
	section('cam init — one failure + one warning');
	let resolveDone: (() => void) | undefined;
	const donePromise = new Promise<void>((r) => {
		resolveDone = r;
	});
	const checks: CheckDef[] = [
		staticCheck('claude', CHECK_FIXTURES.claude.label, CHECK_FIXTURES.claude.description, {
			status: 'fail',
			detail: 'not found',
			hint: 'install Claude Code and make sure it is on PATH.',
		}),
		staticCheck(
			'frontmatter',
			CHECK_FIXTURES.frontmatter.label,
			CHECK_FIXTURES.frontmatter.description,
			{
				status: 'warn',
				detail: 'tsx missing',
				hint: 'npm install --prefix scripts/smoke',
			},
		),
		staticCheck('config', CHECK_FIXTURES.config.label, CHECK_FIXTURES.config.description, {
			status: 'ok',
			detail: 'written',
		}),
	];
	const { lastFrame, unmount } = renderInitWithSplash(checks, () => resolveDone?.());
	await donePromise;
	await delay(50);
	process.stdout.write(lastFrame() + '\n');
	unmount();
}

function snapshotSetupStepMode(): void {
	section('cam setup — step 1: project mode');
	const { lastFrame, unmount } = render(
		<SetupScreen prefilled={{}} onDone={() => {}} onCancel={() => {}} />,
	);
	process.stdout.write(lastFrame() + '\n');
	unmount();
}

function snapshotSetupStepIssue(): void {
	section('cam setup — step 2: issue system (mode confirmed above)');
	const { lastFrame, unmount } = render(
		<SetupScreen
			prefilled={{ projectMode: 'existing' }}
			onDone={() => {}}
			onCancel={() => {}}
		/>,
	);
	process.stdout.write(lastFrame() + '\n');
	unmount();
}

function snapshotSetupStepDescription(): void {
	section('cam setup — step 3: description (new project path)');
	const { lastFrame, unmount } = render(
		<SetupScreen
			prefilled={{ projectMode: 'new', issueSystem: 'github' }}
			onDone={() => {}}
			onCancel={() => {}}
		/>,
	);
	process.stdout.write(lastFrame() + '\n');
	unmount();
}

function snapshotSelectStandalone(): void {
	section('Select — default focus on first option');
	const options = [
		{
			value: 'existing' as const,
			label: 'Existing project',
			description: 'This folder already has code.',
		},
		{
			value: 'new' as const,
			label: 'New project',
			description: 'Empty folder, scaffold from scratch.',
		},
	];
	const { lastFrame, unmount } = render(
		<Select
			question="Is this a new or existing project?"
			options={options}
			defaultValue="existing"
			onChange={() => {}}
			onCancel={() => {}}
		/>,
	);
	process.stdout.write(lastFrame() + '\n');
	unmount();
}

function snapshotSelectConfirmed(): void {
	section('Select — confirmed state (collapsed summary)');
	const options = [
		{
			value: 'github' as const,
			label: 'GitHub',
			description: 'Issues at github.com/.../issues',
		},
	];
	const { lastFrame, unmount } = render(
		<Select
			question="Which issue system does this project use?"
			options={options}
			confirmed
			confirmedValue="github"
			onChange={() => {}}
		/>,
	);
	process.stdout.write(lastFrame() + '\n');
	unmount();
}

async function main(): Promise<void> {
	snapshotSplash();
	await snapshotInitInitial();
	await snapshotInitDoneSuccess();
	await snapshotInitDoneFailure();
	snapshotSetupStepMode();
	snapshotSetupStepIssue();
	snapshotSetupStepDescription();
	snapshotSelectStandalone();
	snapshotSelectConfirmed();
	process.stdout.write('\n');
}

await main();
