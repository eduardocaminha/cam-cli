---
description: Create or look up an issue in the project's configured issue system (Linear, GitHub, or local). Returns the issue identifier the orchestrator can pass to /cam-plan.
argument-hint: "create | get <id> | list"
---

# /cam-issue — issue system dispatcher

This command is the single entry point for issue creation and lookup, regardless
of which issue system the project uses. Read `scripts/cam/project.toml` to
discover the system, then execute the matching path below.

The orchestrator typically calls this command before `/cam-plan` to ensure
the work item exists in the canonical place.

**CLI thin-proxy invocation**: `cam issue "<text>"` (run from a terminal outside the session) is a thin-proxy. It detects the active cam session, waits for the orchestrator to be idle, then injects `/cam-issue create <text>` into the orchestrator pane via atomic `send-keys`. The content below is what the orchestrator executes when it receives this slash command.

---

## Step 1: Read the project's issue system

Read `scripts/cam/project.toml`. Look for the top-level `issue_system` key.

```toml
issue_system = "linear" | "github" | "none"
```

If the file does not exist, default to `none` and warn the operator that
`cam init` was not run (or did not record an issue system).

---

## Step 2: Dispatch on issue_system

### `linear` — Linear

Required: `LINEAR_API_KEY` in the environment, and a Linear team key
(read from `scripts/cam/project.toml` under `linear.team_key` if set,
otherwise ask the operator and persist the answer).

Use the cam Linear client conceptually — but since this command runs inside
a claude session, you do not import code. Instead, make a single GraphQL
POST to `https://api.linear.app/graphql` via Bash + curl:

```bash
curl -sS -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '<JSON body>'
```

Subcommands:

#### `create`
Ask the operator for a one-line title and an optional description, then
mutate `issueCreate(input: { teamId, title, description })`. Print the
returned `identifier` (e.g. `LIN-42`) on its own line as the last output.

#### `get <id>`
Run `query { issue(id: "<id>") { identifier title state { name type } url } }`.
Print a short summary plus the full URL.

#### `list`
Run `query { team(id: "<teamKey>") { activeCycle { issues(first: 50) { nodes { identifier title state { name type } } } } } }`.
Render a table grouped by state.

#### Error handling
If `LINEAR_API_KEY` is missing → tell the operator how to set it
(`https://linear.app/settings/api`) and exit without making the call.
If the GraphQL response has `errors`, surface them verbatim.

---

### `github` — GitHub Issues

Use the `gh` CLI (assumed installed and authenticated; check with
`gh auth status`).

Subcommands:

#### `create`
Ask the operator for a title and body, then:
```bash
gh issue create --title "<title>" --body "<body>"
```
Print the returned issue number prefixed with `#` (e.g. `#42`) on the last line.

#### `get <N>`
```bash
gh issue view <N>
```

#### `list`
```bash
gh issue list --state open --limit 50
```

#### Error handling
If `gh auth status` fails → tell the operator to run `gh auth login` and exit.

---

### `none` — local-only

When the project has no external issue system, the orchestrator stores
issues as individual JSON files in `scripts/cam/issues/`. Each file is named
`<PREFIX>-NNNN.json` (4-digit zero-padded numeric suffix) and contains a single
issue object. This is intentionally lightweight — it lets cam loops work on
solo / private projects without forcing a Linear/GitHub account.

Each issue file shape follows `scripts/cam/issues.schema.json`.

Subcommands:

#### `create`

**CONVENTION**: never hand-edit issue files on a feature branch; always file via `cam issue` (it commits to main deterministically).

1. Expand the free-text argument into a structured **title** (concise, under 80 chars) and an optional **description** (one or two sentences).
2. Build a JSON payload with `title` and `description`. Include `priority` (integer 1-4, 1 = urgent) only when the request implies one.
3. Invoke `cam issue --file-local`, piping the JSON payload to stdin. It commits the new issue directly to `main` without touching the current work branch:
   ```bash
   echo '{"title":"<title>","description":"<description>"}' | cam issue --file-local
   ```
   The command prints the new identifier (e.g. `CAM-42`) to stdout and exits 0 on success.
4. Print the returned identifier and end with:
   ```
   CAM_ISSUE_RESULT=<identifier>
   ```

#### `get <id>`

Derive the padded filename from the id (e.g. `CAM-42` -> `CAM-0042.json`), then
read from main so a just-filed issue is visible from any checked-out branch:
```bash
git show main:scripts/cam/issues/<PREFIX>-NNNN.json 2>/dev/null || cat scripts/cam/issues/<PREFIX>-NNNN.json
```
Print the issue as JSON.

#### `list`

List all issue files in the directory, read each, and render open issues as a
markdown table:
```bash
git ls-tree -r --name-only main scripts/cam/issues/ 2>/dev/null | sort
```
Fallback: `ls scripts/cam/issues/` when git read fails.

Note: a deterministic `cam issue list` CLI command is tracked separately (CAM-74).

---

## Step 3: Output contract

Always end your response with a single line of one of these forms (so the
orchestrator can grep it):

```
CAM_ISSUE_RESULT=<identifier>      # on success (e.g. LIN-42, #17, CAM-3)
CAM_ISSUE_RESULT=ERROR             # on any failure
```

The orchestrator parses this line and uses the identifier in subsequent
commands like `/cam-plan <identifier>`.
