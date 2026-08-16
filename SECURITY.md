# Security Policy

## Supported versions

Gateship is pre-1.0. Security fixes are applied to the latest published
release; older releases may not receive backports.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do
not open a public issue for an undisclosed vulnerability and do not include
provider tokens, credential files, private repository contents, or sensitive
logs in a report.

Include the affected version, impact, reproduction steps, and any suggested
mitigation. Maintainers will acknowledge the report, assess it, and coordinate
disclosure through the private advisory.

## Credential boundary

Gateship executes locally installed Claude Code and Codex clients using their
existing subscription login. Agent and GitHub CLI children receive an explicit
environment allowlist; unrelated API keys, PATs and injected tokens are not
inherited. Gateship does not read or persist provider credentials, and GitHub
authentication remains in `gh`'s own credential store.

The launched agents still run with the operating-system permissions of the
Gateship user. The allowlist prevents accidental environment inheritance; it
does not isolate a malicious same-user process from readable host files.
Project verification commands are trusted and retain the service environment.
See [credentials and notifications](./docs/credentials-and-notifications.md)
for the complete boundary and setup.
