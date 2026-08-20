# Credentials and notifications

Gateship coordinates tools that already own their authentication. It is not a
credential broker or secret store.

## Credential ownership

| Capability | Credential owner | Gateship receives |
| --- | --- | --- |
| Claude subscription | Claude Code | Installed/login status and public run output |
| ChatGPT subscription | Codex app-server | Login URL, status and public run output |
| GitHub shipping | GitHub CLI and Git credential helper | Command result only |
| Local notifications | Browser permission | `default`, `granted` or `denied` |

Set up GitHub through its own browser flow:

```bash
gh auth login --web
gh auth setup-git
gh auth status
```

There is intentionally no PAT or OAuth-token field in the Gateship UI. GitHub
CLI gives `GH_TOKEN` and `GITHUB_TOKEN` precedence over credentials stored by
`gh`; Gateship removes that ambiguity by passing neither variable to any `gh`
command. See the official [`gh` environment documentation](https://cli.github.com/manual/gh_help_environment)
and [`gh auth login`](https://cli.github.com/manual/gh_auth_login).

Running the [container image](../README.md#container) does not change any of
this. `CLAUDE_CONFIG_DIR`, `GH_CONFIG_DIR` and `GIT_CONFIG_GLOBAL` point at the
named volume instead of `$HOME`, so `claude auth login` and `gh auth login`
(with the git credential helper `gh auth setup-git`/`gh auth login` wires into
global git config) still write to the store each tool already owns; Gateship
still never reads it. The image carries no credential of its own, and the
operator authenticates inside the container on first boot, never by copying a
host credential file -- on macOS the Claude CLI keeps its credential in the
Keychain, and there is no such file to copy in the first place.

## Environment boundary

Agent, review, auth-probe and GitHub CLI children receive a small allowlist:
executable/home paths, locale and certificate settings, plus the relevant
Claude, Codex or GitHub configuration directory. An unrelated variable added
to the Gateship process is excluded by default. This includes provider API
keys, GitHub tokens and notification-service keys.

Git and the task's explicit verification commands are different: they are
trusted project operations and may need the host's SSH agent, credential helper
or test configuration, so they run in the Gateship service environment. Do not
start Gateship with secrets that those project commands do not need. Gateship
does not automatically read `.env` files and does not persist environment
values in SQLite.

This boundary prevents accidental inheritance. It is not a sandbox against a
malicious write-capable agent: the agent runs as the same operating-system user
and therefore holds that user's filesystem authority. A stronger adversarial
boundary requires a separate OS identity or sandbox and is deliberately not
part of the local core.

## Notification policy

The first notification adapter is the browser's native Notifications API. The
operator enables it with a browser gesture; Gateship alerts only while the tab
is hidden and only for an operator decision, an unexpected interruption, a
failed/retryable ship, a run failure or a completed merge. It needs no account,
network service or secret. These notifications are non-persistent: closing the
browser also closes this channel.

Resend or another remote channel is useful only when closed-browser delivery is
a measured requirement. It should then remain optional and obey all of these
conditions:

- use a sending-only, domain-scoped key;
- retrieve the key inside the notifier from an operating-system credential
  store, outside the browser, Gateship's service environment, SQLite, logs and
  agent prompts;
- pass the key only to the notifier, never to Claude, Codex, `gh` or task
  verification;
- send the same small set of durable run transitions used by local
  notifications;
- add the concrete channel directly before introducing a generic event bus.

Resend documents both [restricted API keys](https://resend.com/docs/dashboard/api-keys/introduction)
and the requirement to keep them out of browser code and rotate them after
suspected exposure in its [API-key guidance](https://resend.com/docs/knowledge-base/how-to-handle-api-keys).

The web UI may later configure a destination and show adapter health. A setup
flow may write the raw key directly to a platform credential store, but the UI
must never display it again and the server must never return or persist it in
Gateship state. Until that cross-platform boundary is implemented, Resend stays
out of the product rather than becoming another ambient environment variable.
