# Changelog

All notable changes to cam-cli are documented here.

Format: `## [version] - YYYY-MM-DD` for releases; `## [Unreleased]` for staged changes.

---

## [Unreleased]

### Added

- Supervisor now verifies each worker pass actually landed on origin (HEAD == origin/<branch>) before continuing, so an unpushed claim cannot mark a story complete on local-only commits; a failed verification blocks the loop (CAM-33).
- Structured `pushed` event in `.claude/cam-worker-events.jsonl` recording each push verification (`sha`, `pushed`, `ok`, `detail`) for audit (CAM-33).

### Changed

- Retired the stop-hook loop driver; workers are now real per-story claude sessions in a single reused tmux pane (CAM-22, closes CAM-29).
