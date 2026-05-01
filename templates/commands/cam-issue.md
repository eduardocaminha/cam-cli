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
issues in `scripts/cam/issues.local.json`. This is intentionally lightweight
— it lets cam loops work on solo / private projects without forcing a
Linear/GitHub account.

Schema:
```json
{
  "next_id": 1,
  "issues": [
    {
      "id": "CAM-1",
      "title": "...",
      "description": "...",
      "state": "open" | "in_progress" | "closed",
      "createdAt": "<ISO 8601>"
    }
  ]
}
```

Subcommands:

#### `create`
Read or create `scripts/cam/issues.local.json`, allocate `id = "CAM-<next_id>"`,
increment `next_id`, append the issue, write the file back. Print the new
identifier on the last line.

#### `get <id>`
Read the file, find the matching id, print as JSON.

#### `list`
Read the file, render the open issues as a table.

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
