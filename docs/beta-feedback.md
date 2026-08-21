# Beta feedback

Use the [beta feedback issue form](https://github.com/gateship-dev/gateship/issues/new?template=beta-feedback.yml) to report a bug, describe workflow friction, or suggest an improvement from the external beta. The form is public. Do not include tokens, credentials, private source code, or sensitive logs. Report undisclosed vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/gateship-dev/gateship/security/advisories/new).

## Triage contract

The public issue author and issue URL are the feedback's provenance. Maintainers may ask for clarification, close the report, or manually translate an accepted report into a Gateship issue. A translated issue must cite the public feedback URL so that provenance remains visible.

Translation is triage, not runtime authority. Promoting feedback never approves, starts, reprioritizes, or expands a run. Before work can execute, its bounded executable specification and verification commands still require explicit operator approval.

The GitHub Issue Form is a replaceable intake adapter at the repository edge. Gateship does not depend on the form being available and does not ingest it through runtime APIs, webhooks, bots, telemetry, or automatic deduplication.

## What to include

Describe the outcome you wanted, what you observed, what you expected, and either reproduction steps or the desired workflow. Include the Gateship version and relevant installation and environment facts. Sanitized run, provider, model, and effort context is optional. Tell us what clarification, correction, recovery, or other attention the experience required from you.

