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
this. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GH_CONFIG_DIR` and
`GIT_CONFIG_GLOBAL` point at stable subpaths of `GATESHIP_HOME` on the named
volume at `/var/lib/gateship`, instead of `$HOME` or a project's `.gship`, so
each tool still writes to the store it owns; Gateship never reads it.
Authenticate inside the container on first boot:

```bash
docker compose exec gateship claude auth login
docker compose exec gateship codex login --device-auth
docker compose exec gateship gh auth login --web
docker compose exec gateship gh auth setup-git
```

Codex device authentication is the supported headless subscription flow and
persists in `CODEX_HOME`. The GitHub commands also persist the git credential
helper in `GIT_CONFIG_GLOBAL`. The image carries no credential of its own, and
the operator never copies a host credential file into it or supplies a provider
API key. On macOS the Claude CLI keeps its host credential in the Keychain, so
there is no portable host file to copy in the first place.

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
inside the Gateship service and therefore holds that identity's filesystem
authority. The provider process must also be able to read the login store owned
by its own CLI; Gateship cannot both invoke that CLI and make its credential
unavailable to the same process. “Credential blind” is an application contract:
Gateship never parses, copies, returns or persists the credential.

The container narrows the host boundary without pretending to solve that
intra-container fact. Compose uses a read-only image filesystem, an ephemeral
`/tmp`, `no-new-privileges` and a minimal capability set. Only the mounted
projects directory and named global-home volume are durable and writable. The
selected project's state remains in `<repo>/.gship`; the global home contains
the registry and CLI-owned credential stores. Both mounts remain visible to a
write-capable provider process, so this is a trusted single-operator boundary,
not multi-tenant isolation. A stronger adversarial boundary would need a
separate OS identity plus a credential broker; adding directory names or
another folder on the same volume would not provide it.

## Notification policy

The first notification adapter is the browser's native Notifications API. The
operator enables it with a browser gesture; Gateship alerts only while the tab
is hidden and only for an operator decision, an unexpected interruption, a
failed/retryable ship, a run failure or a completed merge. It needs no account,
network service or secret. These notifications are non-persistent: closing the
browser also closes this channel.

Closed-browser delivery is optional. The current server supports one ntfy topic
and one Resend destination, independently; when neither is configured, the
runtime behaves exactly as before. These channels obey the following contract:

- use a sending-only, domain-scoped key;
- resolve it only inside the notifier, from a mode-`0600` file or the service
  environment, outside the browser, SQLite, logs and agent prompts;
- never inject it into Claude, Codex, `gh` or task verification environments;
- send the same small set of durable run transitions used by local
  notifications;
- keep each concrete channel direct; there is no generic integration bus.

The file-backed option is protection against accidental inheritance and
disclosure, not against a hostile provider process with the same filesystem
identity. Use a restricted, revocable credential and treat the mounted project
and `.gship` volume as visible to that process. This is an explicit limitation,
not a claim that mode `0600` separates two processes running as the same user.

Resend documents both [restricted API keys](https://resend.com/docs/dashboard/api-keys/introduction)
and the requirement to keep them out of browser code and rotate them after
suspected exposure in its [API-key guidance](https://resend.com/docs/knowledge-base/how-to-handle-api-keys).

Settings is the normal Resend setup path. Enter a sender on a domain verified
with Resend, the transactional recipient, and optionally a new API key. Saving
with a blank key preserves the current file-backed credential. The key input is
write-only: the service never returns or prefills it. The explicit removal
action deletes only `.gship/resend-api-key`; it does not remove the sender or
recipient.

The service prepares a replacement key in the same `.gship` directory, sets
mode `0600`, and only then atomically renames it over the live file. A failed
preparation therefore leaves the previous valid key intact. Sender and
recipient are non-secret values stored in `.gship/resend-settings.json`, never
in SQLite, and are resolved fresh for status, tests, run notifications and
service notifications.

Environment precedence is independent per field. `GATESHIP_RESEND_API_KEY`,
`GATESHIP_RESEND_FROM` and `GATESHIP_RESEND_TO` each override only their
corresponding file-backed value. Settings identifies environment-managed
fields; saving or removing a file does not claim to change the effective value
while its environment variable remains authoritative.

For a container or manual fallback, place the bare key followed by a newline in
`.gship/resend-api-key`, set its mode to `0600`, and put the non-secret sender
and recipient in Settings or the two environment variables above. The project
and its `.gship` directory must be writable by the Gateship process. Notification
recipients receive only the transactional run and service alerts described
here; configuring a recipient never enrolls that address in marketing or a
mailing list.
