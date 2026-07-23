# CAM Runtime: launch readiness report

A dimension-by-dimension audit of CAM Runtime's fitness for a public v1
release, tracking CAM-330. Each dimension gets an explicit `ready`/`gap`
verdict; a `gap` verdict always carries a concrete gap list, not a bare
token. This report is built incrementally across three stories (US-001 to
US-003 of this PRD): US-001 scaffolds the report and covers distribution,
onboarding, and external-facing docs; later stories append the remaining
dimensions (security/secrets, license/repo-visibility, telemetry/privacy,
versioning/release/update, support channels) plus the prioritized gap
triage and the go/no-go recommendation.

Audited against the current product state: post-CAM-329 rebrand (the
display name is CAM Runtime; the command, binary, and internal identifiers
stay `cam`), pre-CAM-331 README rebuild, pre-CAM-332 brand tokens.

## Verdict Summary

| Dimension | Verdict |
|---|---|
| Distribution / install | gap |
| First-run onboarding (`cam init` UX) | gap |
| External-facing docs (README) | gap |

## Distribution / install: gap

Today CAM Runtime ships as a private, unpublished, single-platform binary,
built and installed by the same script that a contributor uses for local
development. There is no packaged, public distribution path for a stranger.

Concrete gaps:

- **No public distribution channel.** The GitHub repository is private and
  unpublished (see the license/repo-visibility dimension, audited in a
  later story of this report); there is no release page, no Homebrew
  formula, no install-script URL, and no package-manager entry a stranger
  could reach without repo access.
- **No `npm`/`bunx` install path.** `package.json` has `"private": true`
  and no `bin` field. The only paths documented in the README are
  `git clone` + `bun install` + `./scripts/build-release.sh --install`
  (from-source, arm64 only) or hand-writing a shell shim that invokes
  `bun run <absolute path>/index.ts` with a manually edited path
  (`README.md` "Option B"). Neither is a packaged-binary install a
  non-developer would expect.
- **Single platform, single architecture.** `scripts/build-release.sh`
  hardcodes `--target=bun-darwin-arm64`. There is no Linux build, no
  darwin-x64 (Intel Mac) build, and no Windows build. A stranger on any
  other platform has no install path at all short of running from source
  with Bun installed.
- **Ad-hoc code signing only covers the builder's own machine.** The build
  script re-signs the compiled binary with `codesign --force --sign -`
  (ad-hoc identity) so it survives macOS's amfid gatekeeping on the machine
  that built it (see `README.md` "Public distribution note" and the
  documented project lesson that `bun build --compile` binaries fail
  signature validation off the build machine). Distributing a prebuilt
  binary to other users' Macs requires Apple Developer ID signing,
  `notarytool` submission, and stapling, none of which the build scripts
  currently do; today's process only works because every installer
  compiles their own copy.
- **Install still requires a full dev toolchain.** Even the "from source"
  path requires `git`, `bun >= 1.2`, and (per the Prerequisites section)
  `tmux` and the separately-installed, separately-signed-in `claude` CLI
  before `cam --version` ever runs. There is no toolchain-free path for a
  non-developer to obtain a working `cam` binary.

## First-run onboarding (`cam init` UX): gap

`cam init` itself is reasonably well engineered as a *validator*: it checks
`claude` is on PATH and parses its version (soft-warn, not hard-fail on a
version floor mismatch), runs vendored smokes, and writes
`~/.config/cam/config.toml`. The gap is upstream and downstream of that
validator, in what a stranger with no prior cam context is asked to
already know or already have.

Concrete gaps:

- **Onboarding presupposes a working `claude` login before `cam` does
  anything.** `cam init`'s first hard requirement is Claude Code already
  installed and authenticated (`src/commands/init.ts` `validateClaude`);
  there is no in-tool guidance for signing up for or signing into Claude
  Code, and no fallback UX for the very common case of a stranger who has
  never installed Claude Code. The README's Prerequisites section links
  out to Anthropic's docs but `cam init` itself does not detect an
  unauthenticated `claude` and explain what to do next beyond "not on
  PATH".
- **The project-setup wizard (`runSetup`, `src/commands/setup.ts`) asks
  cam-internal jargon with no inline glossary.** A stranger scaffolding a
  fresh project is asked to pick an "issue system" (`linear` / `github` /
  `local`), an agent backend (`claude` / `codex` / `both`, plus which is
  default), and is exposed to `merge_mode` (`immediate` / `ci-gated`) and
  `plan_approval` (`auto` / `operator`) concepts. None of these terms are
  explained at the prompt; a stranger has to already know what "ci-gated
  merge mode" or "operator plan approval" means, or read source/docs first.
- **`tmux` is a hard onboarding dependency with no fallback.** `cam init`
  hands off to a tmux split (or a new tmux session if run outside tmux);
  a stranger without `tmux` installed hits a dependency wall mid-wizard
  rather than at the Prerequisites-check stage.
- **No guided "what did I just get" moment.** After the setup wizard
  finishes, the operator is dropped into a live orchestrator pane and a
  navigable dashboard with a dense single-letter keybinding scheme
  (`n/r/s/p/i`, `j/k`, `Enter`, `Esc`, `d`, `q`); the README documents this,
  but nothing inside the running TUI itself explains the keybindings to a
  first-time user before they have to guess or tab back to the README.

## External-facing docs (README): gap

This dimension is audited by coordinating with, not duplicating, CAM-331
(the README rebuild, currently `specified`/`open`) and CAM-332 (the brand
palette, currently `open`). The verdict below assesses the *current*
README as an external-facing artifact; it does not restate or perform
CAM-331/CAM-332's work.

Concrete gaps:

- **CAM-331 has not shipped yet.** The planned "ultra-professional
  external-facing README" (hero section, vendored architecture figures,
  backend-selection narrative, CAM-332 brand palette) does not exist yet;
  today's `README.md` is the pre-launch, contributor-facing document it
  always was. This dimension cannot read `ready` until CAM-331 lands.
- **The current README reads as internal-contributor documentation, not
  external marketing/onboarding copy.** It leads with a `git clone` +
  `bun install` developer workflow, documents internal implementation
  details (tmux socket isolation, sidecar dispatch internals, pane
  layouts) ahead of "why would I use this", and has no visual assets,
  screenshots, or architecture diagrams for a stranger evaluating the
  project.
- **No brand identity applied yet.** CAM-332 (the canonical brand palette
  and design tokens) is still `open`; the README currently carries no
  consistent visual identity, logo, or social-preview image for external
  sharing.
- **Positioning copy is present but not yet the finished external pitch.**
  The CAM-329 rebrand already landed the "CAM Runtime" name and the core
  one-paragraph positioning statement at the top of the README, so the
  raw material CAM-331 needs is in place; the gap is specifically the
  external-facing structure and assets, not the underlying positioning.

## Coordination note

This report does not file follow-up issues for the gaps above; CAM-330's
final story (US-003 of this PRD) closes the report with the prioritized
gap triage and the go/no-go recommendation, and files blocking gaps as
issues at that point. CAM-331 and CAM-332 already exist as issues and are
explicitly out of scope for this report to duplicate.
