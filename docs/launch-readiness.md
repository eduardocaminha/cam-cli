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
is materially permissive and undocumented as such. `readPermissionMode`
(`src/config/permission-mode.ts`) defaults to `bypassPermissions`
whenever `~/.config/cam/config.toml` is absent or the key is unset, which
matches what `cam init` itself writes by default: every cam-dispatched
`claude` session (orchestrator, worker, reviewer) runs with full
autonomous filesystem and Bash access and no per-action confirmation
prompt, on the bare host, unless the operator explicitly opts into
container mode. The only host-mode guardrail is the
`orch-agent-allowlist.sh` PreToolUse hook, and it is narrowly scoped: it
only fires inside `CAM_SESSION`-marked sessions, and only denies
non-allowlisted Task/Agent subagent spawns plus writes to two specific
worker-protected file paths (`scripts/cam/prd.json`,
`scripts/cam/issues/*`); it does not sandbox or otherwise restrict the
primary agent's general Bash/file-write surface. None of this (the
`bypassPermissions` default, container mode as the actual isolation
boundary, or the allowlist hook's real scope) is disclosed anywhere in
`README.md`.

Concrete gaps:

- **`bypassPermissions` is the undisclosed default for every cam-dispatched
  agent session.** A stranger installing cam and running `cam init` gets
  full autonomous Bash/filesystem access with no per-action confirmation,
  and nothing in the README says so.
- **Host mode, the default path, has no network egress restriction.** The
  default-deny firewall is a container-mode-only guarantee; a stranger who
  never opts into container mode gets none of it.
- **No README/docs Security section.** There is no explanation of the
  permission model, no guidance to run cam only against
  repositories/directories the operator trusts, and no pointer to
  container mode as the higher-isolation alternative.
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

## Coordination note

This report does not file follow-up issues for the gaps above; CAM-330's
final story (US-003 of this PRD) closes the report with the prioritized
gap triage and the go/no-go recommendation, and files blocking gaps as
issues at that point. CAM-331 and CAM-332 already exist as issues and are
explicitly out of scope for this report to duplicate.
