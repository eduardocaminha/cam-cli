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
existing subscription login. It removes common API-key and injected-token
variables from child environments and does not read or persist provider
credentials. The launched agents still run with the operating-system
permissions of the Gateship user.
