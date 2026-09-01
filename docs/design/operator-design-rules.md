# Operator design rules

How an operator gives their project a design contract that Gateship's agents
actually follow, today, with no new runtime machinery.

## The mechanism that already exists

Gateship executors run the operator's coding agent CLI inside the project
worktree, and those CLIs load the repository's own instruction files
(`AGENTS.md`, `CLAUDE.md`). Any rule written there reaches every run's
context. The design rules area builds on that instead of adding an injection
pipeline:

1. The project keeps its design contract in `DESIGN.md` at the repository
   root, owned and versioned like any other file.
2. The project's `AGENTS.md` carries one line pointing UI work at it:
   "For any change that touches user interface, follow `DESIGN.md`."
3. Nothing else. The executor reads it because its CLI already does; the
   reviewer holds the change against it because the file is in the diff's
   repository.

A dedicated runtime feature (typed awareness of the design contract, a
surface listing which rules exist, checks that a UI diff cited them) is a
product change to the deterministic runtime. It stays out of this document's
scope and requires its own approved specification.

## What a DESIGN.md must contain

The contract works when its rules are checkable by an agent without taste:

- Tokens, not opinions: the palette as named roles with literal values, the
  type scale, the radius scale, the elevation recipe. An agent can verify a
  hex; it cannot verify "clean".
- Hard rules with the reason attached, so an agent knows when a rule does
  not apply.
- Measured floors: minimum contrast ratios per role, stated as numbers.
- The accent's semantic: what the accent color means, where it may appear,
  and where it must not.
- Anti-patterns as a short list of forbidden moves.

## The seed preset

`presets/DESIGN.md` in this directory is a complete, adoptable contract
derived from Gateship's own design system. An operator copies it to their
repository root, swaps the accent and the fonts, and keeps the guarantees:
the contrast floors, the state semantics, the motion contract and the
checklists survive any reskin because they are written against roles, not
against the specific colors.

Gateship itself follows the same convention: its `AGENTS.md` points UI work
at `docs/design/design-system.md`, which plays the role of its `DESIGN.md`.
