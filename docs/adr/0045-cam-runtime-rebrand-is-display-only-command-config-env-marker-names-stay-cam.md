# ADR 0045: CAM Runtime rebrand is display-only; command/config/env/marker names stay cam

## Context

The product is renamed cam-cli -> CAM Runtime. The name cam is embedded in behavior-affecting surfaces: the invoked command, ~/.cam and ~/.config/cam directories, CAM_* env vars, the tmux socket 'cam' / @cam_label / cam-orch session prefix, .cam-* state markers, and chore(cam): git trailers. Renaming those would break existing installs, running sessions, on-disk state, and the deterministic git history contract. The GitHub repo and local dir name also feed test fixtures (pr-body/changelog derive the project name from the directory).

## Decision

Scope the rebrand to DISPLAY surfaces only: the splash wordmark (new uppercase CAM), help tagline, tmux status-right label, version-command description, retry config header, package.json name (-> cam-runtime), and README/CHANGELOG prose. Deliberately leave the cam command, config/state directories, CAM_* env vars, tmux socket/labels/session prefix, .cam-* markers, and git trailers unchanged. Defer the GitHub repo / local directory rename to a separate operator-driven step with a coordinated fixture sweep.

## Consequences

The product reads CAM Runtime everywhere a human sees it, while package.json says cam-runtime and every internal namespace still says cam -- an intentional mismatch preserving install/state/session/history compatibility. Contributors seeing cam internals under a CAM Runtime product must consult this ADR. The repo-rename cascade (splash url, pr-body/changelog project-name fixtures, git remote, CI) is a known follow-up, not part of this change.
