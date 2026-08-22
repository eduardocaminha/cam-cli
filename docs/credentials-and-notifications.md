# Credentials and notifications

Gateship coordinates tools that already own their authentication. It is not a
credential broker or secret store.

## Credential ownership

| Capability | Credential owner | Gateship receives |
| --- | --- | --- |
| Claude subscription (default) | Claude Code | Installed/login status and public run output |
| Claude subscription (dedicated, optional) | Gateship, file-backed | A subscription token, generated outside Gateship (see below) |
| ChatGPT subscription | Codex app-server | Login URL, status and public run output |
| GitHub shipping | GitHub CLI and Git credential helper | Command result only |
| Local notifications | Browser permission | `default`, `granted` or `denied` |

Set up GitHub through its own browser flow:

```bash
gh auth login --web
gh auth setup-git
gh auth status
```

There is intentionally no PAT or OAuth-token field for GitHub in the Gateship
UI -- unlike the dedicated Claude credential below, GitHub shipping has no
equivalent. GitHub CLI gives `GH_TOKEN` and `GITHUB_TOKEN` precedence over
credentials stored by `gh`; Gateship removes that ambiguity by passing neither
variable to any `gh` command. See the official
[`gh` environment documentation](https://cli.github.com/manual/gh_help_environment)
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
helper in `GIT_CONFIG_GLOBAL`. Outside of the optional dedicated Claude
credential below, the image carries no credential of its own, and the operator
never copies a host credential file into it or supplies a provider API key. On
macOS the Claude CLI keeps its host credential in the Keychain, so there is no
portable host file to copy in the first place.

## Dedicated Claude credential

By default the Claude provider follows the same rule as everything else in
this document: `claude auth login` on the host or inside the container is the
credential owner, and Gateship only reports whether it is connected. Ajustes >
Providers also offers a second, optional path (GSHIP-704): a subscription
token dedicated to Gateship, isolated from the OAuth/Keychain login Claude
Desktop or the terminal already use. This is the one place in Gateship that
deliberately holds a provider credential, so the boundary below is narrower
and more explicit than the credential-blind rule everywhere else.

Generate the token with the Claude CLI, outside Gateship:

```bash
claude setup-token
```

Paste the printed token once into the masked field in Ajustes > Providers.
Gateship validates it against Claude's own service in an isolated child
process -- carrying that candidate token, never a Keychain credential --
before persisting anything. That check is one minimal, real inference call
with every tool, MCP server, slash command and inherited customization
disabled: `claude auth status` alone is not enough, because it reports a
login for a token the API then refuses. Anything short of a completed call --
a non-zero exit, an error envelope, or output that is not the JSON envelope
the CLI promises -- is a refusal, and nothing is persisted.

What Gateship then confirms is exactly what it demonstrated: that this
credential was accepted for inference. A token from `claude setup-token` is
limited to inference and commonly exposes no email, organization or plan at
all, so neither the screen nor the API promises those fields. When the
isolated status read does report identity it is shown alongside the
confirmation; when it does not, Gateship says so plainly instead of leaving
an empty account to be read as a missing one. Connecting still requires an
explicit checkbox confirmation, so a copy-pasted token cannot silently attach
the wrong subscription. A refused token is neither persisted nor erased from
the field: the CLI prints it once, so it stays in place with the refusal
rendered beside it and the confirmation still checked. The token itself is
never returned to the browser again, on any outcome: connect, reconnect,
rotate and disconnect are all write-only.

The token is stored in one file, `claude-credential`, directly under
`GATESHIP_HOME` -- never inside a project's repository or `.gship` directory,
and never in the runs database. Native installs default `GATESHIP_HOME` to
`~/.gateship`; the container points it at the named volume the same way it
already does for `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, so the credential
survives a container recreate. The file is written mode `0600` via a
prepare-then-atomic-rename, the same pattern the Resend API key below uses.
This is host-filesystem permission protection, not encryption: there is no
external root of trust here to back that claim, and a hostile process running
as the same operating-system identity is not the boundary this defends
against.

`CLAUDE_CODE_OAUTH_TOKEN` in the Gateship service's own environment is also
accepted, and always wins over the file -- the same precedence the Resend API
key's own environment variable already follows -- so an automated or
container install can provision the token at boot without ever touching
Ajustes. Gateship reads it exactly once, at boot, and removes it from the
service's own `process.env` immediately, before anything else runs: it is
never left sitting in the ambient environment for the rest of the process's
life, which is what keeps it out of the verification command's and git's own
environment (see Environment boundary below).

While this variable is set, Ajustes and the `/api/providers/claude/credential`
route treat the credential as read-only: connect, rotate and disconnect are
all unavailable, since a Settings write would only create or remove a file
the environment variable would keep overriding regardless -- a write with no
effect on what actually authenticates. Ajustes explains this and points at
the fix; `PUT` and `DELETE` both answer `409` with a stable `env-managed`
code for any other client. Changing which Claude subscription Gateship uses
in this mode means changing or removing `CLAUDE_CODE_OAUTH_TOKEN` in the
service's own configuration and restarting it -- the same operation that set
it in the first place.

The resolved value -- from that one boot read, or from the file, whichever
wins -- reaches every Gateship-owned Claude CLI spawn, and nothing else: the
provider auth-status probe, the orchestrator's, executor's and reviewer's own
Claude CLI children, and the read-only probe Ajustes uses to validate a saved
model/effort choice before persisting it. A distinct, narrower case is the
one-time candidate-token validation spawn described above: it carries only
the operator-supplied token being connected, in isolation, before that token
has resolved into "the" dedicated credential at all. In every one of these
cases the token takes precedence over `CLAUDE_CONFIG_DIR` for auth, but
`CLAUDE_CONFIG_DIR` itself still reaches the child unchanged alongside it:
that variable also carries session/`--resume` state, and in the canonical
Docker path it already names a subpath of the persistent `GATESHIP_HOME`
volume rather than Claude Desktop's own store, so there is nothing to isolate
away from there and removing it would only break `--resume` across a
container recreate. The precedence instead rests on the Claude CLI's own
documented behavior for `CLAUDE_CODE_OAUTH_TOKEN`: once set, the CLI
authenticates with it and does not fall back to a credential it might find via
`CLAUDE_CONFIG_DIR`, so a revoked or expired token still fails closed rather
than quietly reauthenticating another way. Gateship's own project commands,
the verification command, durable events, logs, HTTP responses and every
other provider (Codex included) never receive this token; it is threaded
explicitly through the Claude-only code paths above, not left sitting in the
service's ambient environment for an allowlist to filter.

A dedicated credential that stops authenticating is reported the same way any
other Claude authentication failure already is -- an `auth-required`
availability hold naming reconnection, surfaced next to the provider in
Ajustes -- rather than a silent fallback to `claude auth login`. Disconnecting
removes the file; it does not touch `CLAUDE_CONFIG_DIR` or the Keychain, so
the external login flow (kept as a clearly marked advanced option) keeps
working exactly as it did before a dedicated credential was ever configured.

A boot-provisioned token needs one explicit exception to "never left sitting
in the service's ambient environment": Gateship's own native self-update
replaces the running process, first with a short-lived helper and then with
the successor server, and neither can read this process's own `process.env`
(already cleared at boot) or the disk-persisted handoff plan (which never
carries it). The captured snapshot is instead forwarded as an explicit,
minimal addition to each spawn's own environment -- old server → helper,
helper → successor (and, on a failed candidate, helper → the restored
previous binary) -- never merged back into this process's own `process.env`,
never written to the plan file, SQLite or a notification. The successor
captures it again and clears it at its own boot, exactly like the very first
server process did; the helper itself never runs a project command, so it
never reaches `runOwnedCommand`'s environment either way.

## Environment boundary

Agent, review, auth-probe and GitHub CLI children receive a small allowlist:
executable/home paths, locale and certificate settings, plus the relevant
Claude, Codex or GitHub configuration directory. An unrelated variable added
to the Gateship process is excluded by default. This includes provider API
keys, GitHub tokens and notification-service keys.

`CLAUDE_CODE_OAUTH_TOKEN` is the one deliberate exception, and it is not part
of this allowlist mechanism: the dedicated Claude credential above is threaded
explicitly into the Claude-only call sites that need it (listed above), never
read off the service's ambient environment by the shared allowlist builder
every other child uses. Codex, GitHub CLI and Git never see it either way.

Git and the task's explicit verification commands are different: they are
trusted project operations and may need the host's SSH agent, credential helper
or test configuration, so they run in the Gateship service environment. Do not
start Gateship with secrets that those project commands do not need -- this is
exactly why the dedicated Claude token is captured out of `process.env` at
boot and never simply left exported into that environment. Gateship does not
automatically read `.env` files and does not
persist environment values in SQLite.

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
