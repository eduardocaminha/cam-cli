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
stay `cam`), post-CAM-332 brand tokens (already shipped), pre-CAM-331
README rebuild.

## Verdict Summary

| Dimension | Verdict |
|---|---|
| Distribution / install | gap |
| First-run onboarding (`cam init` UX) | gap |
| External-facing docs (README) | gap |
| Security / secrets | gap |
| License / repo-visibility | ready |
| Telemetry / privacy stance | gap |
| Versioning / release / update-path | gap |
| Support channels | gap |

## Distribution / install: gap

Today CAM Runtime ships as an unpackaged, single-platform binary, built and
installed by the same script that a contributor uses for local development.
The source repository is public (see the license/repo-visibility dimension
below), but there is no packaged, public distribution path for a stranger.

Concrete gaps:

- **No packaged distribution channel, despite a public repo.** The GitHub
  repository is public (verified directly against the GitHub API for this
  report; see the license/repo-visibility dimension below for the full
  audit), so a stranger can find and clone it, but there is still no
  release page, no Homebrew formula, no install-script URL, and no
  package-manager entry: cloning and building from source is the only
  path in.
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
- **Staged product rename to `gateship` has no tracked item here
  yet.** ADR-0050 (the Gateship naming decision) explicitly defers the
  binary rename to launch packaging, "as a distribution item of launch
  readiness": the canonical binary moves from `cam` to `gateship`, a
  typed alias (if any) is chosen and created by the installer at that
  stage, and `cam` is demoted to an undocumented legacy symlink for
  existing installs. None of the distribution work audited above
  (packaging, cross-platform builds, code signing) currently accounts
  for that rename; it belongs in this dimension's checklist so the
  staged plan has a tracked home when launch packaging picks it up.
  The public domain `gateship.dev` is registered (Porkbun,
  2026-07-27, USD 8.75 first year), so packaging, installer copy and
  the public README can treat it as the canonical home.

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
(the README rebuild, currently `specified`/`open`); CAM-332 (the brand
palette) has already shipped (`stage: shipped`) and its tokens are the
palette CAM-331 is expected to draw from. The verdict below assesses the
*current* README as an external-facing artifact; it does not restate or
perform CAM-331's remaining work.

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
- **No brand identity applied to the README yet.** CAM-332 (the canonical
  brand palette and design tokens) has already shipped
  (`src/design/tokens.ts`, `brandGreens`/`brandNeutrals`), but nothing has
  wired it into the README: the document still carries no consistent
  visual identity, logo, or social-preview image for external sharing.
  This is now purely a CAM-331 application gap, not a CAM-332 blocker.
- **Positioning copy is present but not yet the finished external pitch.**
  The CAM-329 rebrand already landed the "CAM Runtime" name and the core
  one-paragraph positioning statement at the top of the README, so the
  raw material CAM-331 needs is in place; the gap is specifically the
  external-facing structure and assets, not the underlying positioning.

## Security / secrets: gap

cam's own attack surface for credentials is narrow and mostly well
engineered. cam never stores or reads a raw Anthropic API key itself:
Claude authentication is fully delegated to the `claude` CLI's own
login/keychain state in host mode, or to a mounted `claude-code-config`
Docker volume in container mode (`.devcontainer/devcontainer.json`).
`GITHUB_TOKEN` mutation calls (`gh pr create`/`merge`/`comment`,
`gh pr update-branch`) deliberately strip the token from the child
process env so `gh` falls back to its own keyring OAuth credential
rather than trusting a possibly under-scoped `.env` fine-grained PAT
(`src/release/ship-pr.ts`, `src/commands/sidecar.ts`). `LINEAR_API_KEY`
and `RESEND_API_KEY` are read from `process.env` only and never written
to disk by cam, and `.env` itself is gitignored (confirmed untracked in
this working tree). Container mode passes `GITHUB_TOKEN` and
`CLAUDE_CODE_OAUTH_TOKEN` into the container by name only, never as a
literal `KEY=value` argv token, so the value never appears in a process
listing or `docker inspect` (`src/supervisor/worker-container.ts`).
Container mode (opt-in, CAM-241 epic) also adds genuine defense-in-depth
beyond host mode: a default-deny egress firewall (`iptables` plus
`dnsmasq --ipset`, an exact 7-domain allowlist, idempotent, self-verifying
on every start, `.devcontainer/init-firewall.sh`), and typed, fail-closed
`docker exec` appliers for firewall/config/auth
(`src/supervisor/container-firewall.ts`, `container-config.ts`,
`container-auth.ts`) that throw a specific typed error rather than
silently proceeding on failure.

Set against that engineering, the *default* operating mode (no container)
is materially permissive and, as of this audit (pre-CAM-331 README
rebuild), undocumented as such. `permission_mode = "bypassPermissions"`
is hardcoded as a literal at every spawn site (`src/commands/run.ts`,
`src/commands/setup.ts`, `src/commands/sidecar.ts`,
`src/supervisor/plan-runner.ts`): there is no `permission_mode` config
key, it is not read by any spawn path, and no subcommand accepts a
`--permission-mode` flag. Every cam-dispatched `claude` session
(orchestrator, worker, reviewer) runs with full autonomous filesystem
and Bash access and no per-action confirmation prompt, on the bare
host, unless the operator explicitly opts into container mode (or, for
worker/reviewer sessions only, sets `[loop] worker_isolation =
"container"` in `scripts/cam/project.toml`; the orchestrator pane
itself is always spawned on the host regardless of that setting). The
only host-mode guardrail is the `orch-agent-allowlist.sh` PreToolUse
hook, and it is narrowly scoped: it only fires inside
`CAM_SESSION`-marked sessions, and only denies non-allowlisted
Task/Agent subagent spawns plus writes to two specific
worker-protected file paths (`scripts/cam/prd.json`,
`scripts/cam/issues/*`); it does not sandbox or otherwise restrict the
primary agent's general Bash/file-write surface. None of this (the
`bypassPermissions` default, container mode as the actual isolation
boundary, or the allowlist hook's real scope) was disclosed anywhere in
`README.md` at the time of this audit.

Concrete gaps:

- **`bypassPermissions` was the undisclosed default for every
  cam-dispatched agent session, at the time of this audit.** A stranger
  installing cam and running `cam init` gets full autonomous
  Bash/filesystem access with no per-action confirmation, and nothing
  in the README said so.
- **Host mode, the default path, has no network egress restriction.** The
  default-deny firewall is a container-mode-only guarantee; a stranger who
  never opts into container mode gets none of it.
- **No README/docs Security section, at the time of this audit.** There
  was no explanation of the permission model, no guidance to run cam
  only against repositories/directories the operator trusts, and no
  pointer to container mode as the higher-isolation alternative.
- **No `SECURITY.md` vulnerability-disclosure policy** at the repo root,
  standard practice for a public OSS project accepting external scrutiny.

## License / repo-visibility: ready

Verified directly against GitHub for this report (`gh repo view`,
`gh api repos/eduardocaminha/cam-cli`), the repository's actual state
differs from the premise this story was planned under: `cam-cli` is
already **public** (`private: false`, `visibility: public`), not
private/unpublished. It has carried a public description, topics, and CI
plus branch protection as a deliberate, tracked operator decision since
mid-2026, not an oversight. The root `LICENSE` file is a valid MIT
license (`Copyright (c) 2026 Eduardo Caminha`), correctly detected by
GitHub's own license API (`license.key: "mit"`). Third-party attribution
for the one vendored dependency this codebase carries (`src/retry/*`,
ported from the MIT-licensed claude-auto-retry project) is properly
recorded in `LICENSES/claude-auto-retry-MIT.txt` and cross-linked twice
from `README.md` plus the top-level License section. Separately,
`claude-code-harness/` (a local, reference-only checkout of Claude Code's
own source used for behavior-parity comparisons, see `HANDOFF.md`) is
listed in `.gitignore`, confirmed absent from git history, and confirmed
NOT among the files `scripts/generate-embedded-vendor.ts` actually
embeds into the distributed binary (only 3 files under `vendor/` plus
`templates/` are); the "vendor/ and claude-code-harness/ embedded at
build time" phrasing elsewhere in project docs describes a local
dev/build convention, not what ships publicly, so it carries no
public-repo license-exposure risk despite the phrasing.

Two items remain pending but are non-blocking for this dimension
specifically: the GitHub repository name (`eduardocaminha/cam-cli`) has
not yet been renamed to match the CAM Runtime brand, which is explicitly
CAM-329's separate GitHub-side operator step (out of scope for this
story, factored in here only); and the repo carries no `SECURITY.md`,
`CONTRIBUTING.md`, or `CODE_OF_CONDUCT.md`, a common but non-blocking
polish item for a public OSS launch. `package.json`'s `"private": true`
field and un-renamed `cam-runtime` package name are distribution-dimension
details already covered in the Distribution / install section above, not
license/visibility gaps.

## Telemetry / privacy stance: gap

cam ships with no first-party telemetry or analytics code: an exhaustive
source grep for telemetry/analytics vendor SDKs (PostHog, Segment,
Mixpanel, Sentry, Amplitude, Datadog, LogRocket) and for the literal
strings `telemetry`/`analytics` returns nothing outside prose comments
about *Claude Code's own* traffic; cam itself does not phone home, does
not collect usage metrics, and does not transmit anything beyond what its
own documented integrations (Claude Code, `git`/`gh`, the Linear GraphQL
API, Resend for the optional operator-notification email) inherently
require to function. Container mode goes one step further and actively
opts the in-container `claude` process out of Anthropic's own
non-essential traffic: `.devcontainer/devcontainer.json` and
`src/supervisor/worker-container.ts` both set
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_AUTOUPDATER=1`
on every container-mode worker.

That container-mode opt-out is not applied in host mode, cam's default
path: neither `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` nor
`DISABLE_AUTOUPDATER` is set anywhere in the host-mode dispatch path, so a
default installation inherits whatever telemetry/auto-update behavior the
`claude` CLI ships with, undiminished. More fundamentally, none of this
(the absence of first-party cam telemetry, the third-party data flows
cam's normal operation necessarily creates toward Anthropic, GitHub,
Linear, and Resend, or the host-vs-container inconsistency in disabling
Claude Code's non-essential traffic) is written down anywhere a stranger
evaluating this tool could find it. An autonomous agent that reads a
repository, writes code, and pushes commits and PRs on the operator's
behalf is exactly the kind of tool a privacy-conscious adopter checks for
an explicit data-flow statement before installing.

Concrete gaps:

- **No documented telemetry/privacy stance anywhere** (no README section,
  no `PRIVACY.md`), despite the underlying fact, no first-party cam
  telemetry, being genuinely favorable.
- **Inconsistent non-essential-traffic opt-out.**
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` is only set in container
  mode; host mode, the default, leaves Claude Code's own
  telemetry/auto-update behavior at its out-of-the-box default.
- **No explicit enumeration of third-party data flows** (Anthropic via
  `claude`, GitHub via `git`/`gh`, Linear via `LINEAR_API_KEY`, Resend via
  `RESEND_API_KEY`) for an operator to review before trusting cam with
  push/PR-creation authority on their behalf.

## Versioning / release / update-path: gap

Internally, versioning is disciplined: `src/version.ts`'s `CAM_VERSION` and
`package.json`'s `version` are kept in lockstep (`test/version.test.ts`
asserts equality), semantic-release-style bumps run through `cam ship
--bump`/`computeNextVersion` with a documented 0.x-major-demotion
convention, `CHANGELOG.md` follows Keep a Changelog with a line-anchored
`## [Unreleased]` heading and one dated section per version, and every
release is tagged (`git tag`, `vX.Y.Z` at the correct post-squash-merge
main SHA per the project's own tag-timing runbook). This machinery has
produced 252 version bumps and 252 pushed tags to date, verified directly
against this working tree's tag list and `CHANGELOG.md`.

That entire pipeline stops at the git tag: verified directly with
`gh release list`, this repository has published **zero** GitHub Releases
despite 252 tags. There is no release-notes page, no attached binary
artifact, and (per the distribution/install dimension above)
`scripts/build-release.sh` produces a single darwin-arm64 binary that is
never uploaded anywhere; every install, including every re-install after
a version bump, means the user re-clones and rebuilds from source. There
is also no update mechanism at all for an already-installed `cam` binary:
no `cam update`/`cam upgrade` subcommand, no version-check-on-launch, no
`DISABLE_AUTOUPDATER`-equivalent self-update path (that env var and its
sibling `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` only govern the
*wrapped* `claude` CLI's own auto-update behavior, never `cam` itself).
A user who installed `cam` last month has no way to discover, from inside
`cam`, that 20+ newer versions exist, and no supported path to move to one
short of re-running the from-source install steps by hand.

Concrete gaps:

- **No published GitHub Releases**, despite a disciplined tag-per-version
  history; a stranger browsing the repo's Releases tab today finds it
  empty.
- **No update mechanism for an installed binary.** No `cam update`
  subcommand, no version-check, no self-update path; re-running the
  from-source install script is the only way to move versions.
- **No versioned binary distribution artifact at all** (compounds the
  distribution/install dimension's finding above): even a manual update
  means rebuilding from source, not downloading a new binary.
- **No documented deprecation/compatibility policy** for a 0.x product
  making frequent (multiple-per-day) minor bumps: nothing states what, if
  anything, is stable across versions for an external adopter pinning a
  version.

## Support channels: gap

The GitHub repository has Issues enabled (`has_issues: true`, verified via
`gh api repos/eduardocaminha/cam-cli`) and a CI workflow
(`.github/workflows/ci.yml`), so a baseline public bug-report surface
exists. Everything past that baseline is either absent or exists only in
a form aimed at the maintainer's own automated loop, not at an external
user asking for help.

Concrete gaps:

- **No `.github/ISSUE_TEMPLATE/`.** Filing a bug or feature request on
  GitHub gets a blank textbox; there is no structured template guiding a
  reporter to include version, platform, or reproduction steps.
- **No `CONTRIBUTING.md`.** A stranger who wants to file a well-formed
  issue or send a PR has no documented process, coding conventions
  pointer, or PR checklist (this gap is also flagged, non-blocking, under
  license/repo-visibility above; it is restated here because it is
  simultaneously a support-channel gap, not only a repo-hygiene one).
- **No `SECURITY.md` vulnerability-disclosure channel** (same underlying
  file gap as the security/secrets dimension above): a researcher finding
  a vulnerability has no private-disclosure path and would have to file a
  public GitHub issue.
- **GitHub Discussions is disabled** (`has_discussions: false`) and the
  GitHub Wiki is present but empty and unused (`has_wiki: true`,
  default-on, no content): there is no async Q&A or community-support
  surface beyond bug-tracker Issues.
- **No real-time or maintainer-contact channel documented anywhere.** The
  README has no "Getting help", "Support", or "Contact" section; there is
  no Discord/Slack, no maintainer email, and no response-time expectation
  set for issues filed against a public repo.
- **`cam issue`, the project's own issue-filing CLI, is a tool for
  cam-managed *downstream* projects' backlogs, not a support channel for
  cam-cli itself.** It files into a project's local `scripts/cam/issues/`
  store or Linear/GitHub per that project's config; it is not a substitute
  for cam-cli's own external-facing GitHub Issues, and nothing in the
  README distinguishes the two for a stranger who might otherwise assume
  `cam issue` is "how you report a cam bug".

## Prioritized gap triage

Audited against the current product state described in the header above,
including the post-CAM-54 codex backend (Codex CLI ships as a complete,
per-subagent-selectable alternative to Claude: `[backend]` /
`[models.<backend>]` in `project.toml`, the setup wizard's "which backend
per subagent, and which is default" prompts, `src/supervisor/backend-adapter.ts`,
`codex-auth.ts`; verified `stage: shipped` in
`scripts/cam/issues/CAM-0054.json`). Eight of the nine dimensions above
carry a `gap` verdict; only license/repo-visibility is `ready`. Ranked by
severity to a stranger evaluating or trusting this tool for a public v1,
most severe first:

1. **Security / secrets, undisclosed `bypassPermissions` default (P0,
   must-fix).** Every cam-dispatched agent session runs with full
   autonomous Bash/filesystem access by default, on the bare host, with
   zero README disclosure. This is the single most launch-relevant fact
   in the whole audit: a stranger cannot make an informed trust decision
   about running cam against their own machine without knowing this.
2. **External-facing docs / README, CAM-331 not yet shipped (P0,
   must-fix).** The README a stranger reads first is still the
   internal-contributor document; it is also the document that would
   carry the security disclosure above and the support-channel gaps
   below, so shipping CAM-331 is the concrete remediation vehicle for
   most of this triage's other items, not an independent gap.
3. **Distribution / install, no packaged binary for any platform (P1,
   must-fix).** A public repo with a from-source-only, single-platform,
   dev-toolchain-required install path is not yet a public-v1-shaped
   distribution story, independent of how good the README ends up being.
4. **Telemetry / privacy stance, undocumented data flows (P1,
   must-fix).** The underlying facts are favorable (no first-party cam
   telemetry), which makes this cheap to fix relative to its trust value:
   writing down what already is true is lower-risk work than the items
   above, but it is still must-fix because an autonomous agent that
   pushes code and PRs on the operator's behalf is exactly the tool a
   privacy-conscious adopter checks before installing.
5. **First-run onboarding, jargon-heavy setup wizard (P2, follow-up).**
   Real friction for a first-time stranger, but it degrades the
   experience rather than misrepresenting risk; does not block a v1 tag.
6. **Versioning / release / update-path, no Releases page and no update
   mechanism (P2, follow-up).** Internal versioning discipline is already
   solid; the gap is purely external polish (a Releases page, eventually
   a `cam update` path) that can follow v1 rather than gate it.
7. **Support channels, no templates/contact/disclosure surface (P2,
   follow-up).** Baseline GitHub Issues already exists; templates,
   `CONTRIBUTING.md`, and a documented contact path are standard OSS
   polish, not a v1 blocker, though the `SECURITY.md` sub-item is shared
   with the P0 security disclosure item above and should land together
   with it.
8. **License / repo-visibility, `ready` with two tracked pending items
   (not a gap; carried forward as follow-ups only).** MIT license,
   correct attribution, and public visibility are already sound; the two
   pending items (GitHub repo rename, missing policy files) are
   explicitly non-blocking per that dimension's own verdict.

## Go / no-go recommendation

**No-go for public v1 as of this audit.** Four must-fix items block the
tag (items 1-4 in the triage above): the undisclosed `bypassPermissions`
default, the not-yet-shipped external README (CAM-331), the from-source-only
single-platform distribution path, and the undocumented telemetry/privacy
stance. All four are documentation-and-packaging work, not architecture
changes: the underlying engineering (permission-mode plumbing, container-mode
isolation, the zero-first-party-telemetry fact, the working build script) is
already sound in every case; the gap is disclosure and packaging, not a
redesign. None of the four is scoped to CAM-331/CAM-332 alone, so shipping
CAM-331 closes the README item directly but not the other three.

**Must-fix blocking set (must land before a public v1 tag):**

- Disclose the `bypassPermissions` default and the container-mode
  alternative in the README (Security section).
- Ship CAM-331 (the external-facing README rebuild), or otherwise elevate
  the current README, so a stranger's first read is not the
  internal-contributor document.
- Provide at least one packaged, non-source install path (a signed
  release binary attached to a GitHub Release is the minimum bar; full
  cross-platform builds and package-manager entries can follow).
- Publish a telemetry/privacy statement (a README section or `PRIVACY.md`)
  enumerating the third-party data flows (Anthropic, GitHub, optionally
  Linear/Resend) and the host-vs-container non-essential-traffic
  inconsistency.

Every dimension carrying a `gap` verdict maps to either this must-fix set
(security, external docs, distribution, telemetry: items 1-4) or the
Follow-up Issues list below (onboarding, versioning/release, support
channels: items 5-7), and the one `ready` dimension (license/repo-visibility)
contributes its two pending items to the same follow-up list rather than
being force-fit into either bucket, consistent with the triage above.

## Follow-up Issues

Ready-to-file issue specs for the orchestrator/operator to file on main via
`/cam-issue` once this report closes. Per the CAM-162 defect rule, this
worker story does not hand-file these on-branch itself.

**Must-fix (blocking public v1; file as high-priority issues alongside, not
instead of, direct action on the must-fix set above):**

- **Title: "Disclose bypassPermissions default and container-mode
  alternative in README."** Scope: add a Security section to `README.md`
  (or a linked `docs/security.md`) stating the `bypassPermissions` default
  for every cam-dispatched agent session, the scope of the
  `orch-agent-allowlist.sh` hook, and container mode as the higher-isolation
  opt-in; add `SECURITY.md` with a vulnerability-disclosure contact.
- **Title: "Publish a telemetry/privacy statement."** Scope: add a README
  section or `PRIVACY.md` enumerating cam's third-party data flows
  (Anthropic/claude, GitHub/git+gh, optional Linear, optional Resend), state
  plainly that cam has no first-party telemetry, and either apply
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`/`DISABLE_AUTOUPDATER` in host
  mode too or document why host mode intentionally differs from container
  mode.
- **Title: "Ship at least one packaged, non-source cam install path."**
  Scope: attach a signed/notarized (or at minimum ad-hoc-resigned,
  clearly-labeled-unsigned) darwin-arm64 binary to a GitHub Release, and
  document the download-and-run steps in the README as an alternative to
  the from-source path; cross-platform builds and package-manager entries
  are separate, lower-priority follow-ups, not part of this issue's scope.
- (CAM-331, the external-facing README rebuild, already exists and is
  in progress; do not re-file it, only reference it as satisfying the
  must-fix external-docs item once it ships.)

**Non-blocking follow-ups (observations, not blockers):**

- **Title: "Add first-run in-tool guidance for jargon-heavy setup
  wizard."** Scope: inline glossary or help text for `issue_system`,
  `backend`/per-subagent model selection, `merge_mode`, and `plan_approval`
  during `cam init`'s setup wizard; a `claude`-not-authenticated detection
  path beyond "not on PATH"; a first-run keybinding hint inside the
  dashboard TUI.
- **Title: "Publish GitHub Releases for tagged cam-cli versions."** Scope:
  wire `gh release create` into the tag flow (`cam tag` or the ship
  pipeline) so each of the existing 252+ tags going forward gets a
  corresponding Release with changelog notes; backfill is optional.
- **Title: "Add a `cam update`/version-check path for installed
  binaries."** Scope: a subcommand or `cam init`-time check that compares
  the installed binary's version against the latest tag/Release and
  prints an upgrade hint; does not need to auto-install.
- **Title: "Add GitHub issue templates, CONTRIBUTING.md, and enable
  Discussions."** Scope: `.github/ISSUE_TEMPLATE/` (bug report, feature
  request), a root `CONTRIBUTING.md` (dev setup, PR checklist, coding
  conventions pointer), and enabling GitHub Discussions or documenting an
  alternative async support channel.
- **Title: "Rename the GitHub repository from cam-cli to cam-runtime."**
  Scope: CAM-329's own separate GitHub-side operator step (rename
  `eduardocaminha/cam-cli`), carried forward from the license/repo-visibility
  dimension's `ready` verdict; non-blocking, not this report's action item.
- **Title: "Add SECURITY.md, CONTRIBUTING.md, and CODE_OF_CONDUCT.md at
  the repo root."** Scope: the license/repo-visibility dimension's other
  pending item; `SECURITY.md` overlaps with the must-fix security-disclosure
  issue above and should be authored once, satisfying both.
