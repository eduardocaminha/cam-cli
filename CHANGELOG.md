# Changelog

All notable changes to cam-cli are documented here.

Format: `## [version] - YYYY-MM-DD` for releases; `## [Unreleased]` for staged changes.

---

## [Unreleased]

### Changed

- Retired the stop-hook loop driver; workers are now real per-story claude sessions in a single reused tmux pane (CAM-22, closes CAM-29).
