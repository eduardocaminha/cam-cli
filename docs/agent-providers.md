# Agent providers

Gateship's bus is the small `AgentSession` contract, not a model protocol and
not a second process. A provider adapter receives one turn with a native session
id, working directory, cancellation signal, access role, prompt, and optional
output schema. It returns public prose plus optional structured output.

The built-in adapters invoke the operator's signed-in Claude Code or Codex CLI.
Authentication stays outside Gateship for Codex: the service may report
whether a subscription is connected and initiate the client's managed browser
login, but it never reads or stores a token.

Claude is the one deliberate exception (GSHIP-704). Ajustes > Providers can
connect a dedicated Claude subscription token, generated with
`claude setup-token` and isolated from Claude Desktop's or the terminal's own
OAuth/Keychain login. See
[Credentials and notifications](credentials-and-notifications.md#dedicated-claude-credential)
for storage, precedence and rotation. External login (`claude auth login`)
remains an explicit, clearly marked advanced fallback when no dedicated
credential is configured.

## Optional local agents

A local or free model does not belong in the core until a real client can meet
the same boundary. An optional adapter may be added when it can provide:

- non-interactive streamed turns without terminal keystrokes;
- a durable provider-native session id, or an explicit stateless mode;
- process-group cancellation owned by Gateship;
- mechanically distinct read-only and write-capable roles;
- structured final output without sentinel files;
- no extra daemon, broker, database, or credential store inside Gateship.

If a client exposes ACP or another agent protocol, its translation belongs at
this adapter edge. Gateship should not adopt that protocol as its internal bus:
doing so would make two working subscription clients depend on an abstraction
required only by an optional third provider.

Provider admission is behavioral. The adapter must pass the same session,
cancellation, role-isolation, and credential-blind tests as the native clients.
Until one concrete local client satisfies those checks, keeping the seam small
is more useful than shipping a speculative universal adapter.
