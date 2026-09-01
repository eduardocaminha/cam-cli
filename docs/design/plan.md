# Design system implementation plan

> Companion to `design-system.md`. Each stage is an approvable, shippable
> slice on its own, under Gateship's normal contract (an approved spec
> authorizes the change). Visual layer and information organization only; the
> runtime stays untouched.

## Stage 1: foundations in the webui

Deliverable: the new theme live on the current screens, nothing reorganized.

- Base: the shadcn preset `bbVKEfi` (style `base-maia`, Base UI + Tailwind
  v4), adopted raw first, with the design-system layers applied on top one
  slice at a time. Done on 2026-08-24: preset tokens merged into
  `webui/src/index.css` (run-state families preserved), `cn` adopted
  clsx + tailwind-merge, Inter Variable vendored as the shipped face (see
  R1: Saans cannot be redistributed), embedded and served by the binary.
- Next slices on these tokens: acid into `--accent` plus `--accent-ui` and
  `--accent-text` (the light ramps); states migrating to the vivid text and
  background duos; radius, hairline shadow, top reflection and the pill
  reset as utilities.
- Verification: the repo's `bun run check:all` plus a dark and light visual
  pass.

## Stage 2: component kit

Deliverable: `webui/src/components/ui/` with the 10 components from section 3
of the design doc, and the current surfaces consuming the kit.

- Model: shadcn-style copy-paste components owned by the repo, styled by the
  Stage 1 tokens. Behavioral primitives (dialog, menu, popover, tooltip,
  tabs, toast) come from Base UI, adopted on demand the first time one is
  actually needed; presentational components are written locally because
  there is no behavior to adapt.
- Delivered on 2026-08-24: Button (Base UI, five variants, the acid one
  consumed by the operator-decision form), Badge (state pills, stronger
  tints), Card (theme elevation, surface radius), AttentionCard (the only
  acid surface, consuming the waiting-user prompt), EmptyState (gate mark,
  consuming the chat and overview empties), sidebar active state off
  aria-current with the acid selection bar, inputs as risen white controls,
  tabular-nums on time elements.
- Deferred to Stage 3 with reason: Stat, Table, Timeline and the nested
  composition need the re-hierarchized surfaces to have honest consumers;
  today's cohort and activity panels are catalog-sentence lists, and forcing
  hero-number or table components onto them would fight the i18n catalogs.
- Verification: existing webui tests plus dark and light screenshots per
  surface.

## Stage 3: screen rehierarchization

Deliverable: the surfaces reorganized by the rule "what needs me first"
(section 4 of the design doc).

- Delivered on 2026-08-24: overview bento with the aggregated-attention hero
  tile (acid only while the count is nonzero) over Stat tiles; previous runs
  as a dense Table (mono uppercase headers, right-aligned numeric columns,
  new column labels in both catalogs); the data voice (mono) on issue ids,
  costs and timestamps in run rows and the activity timeline. Project home
  already answered "what needs me" (the internal question pins between log
  and composer) and was left alone.
- Remaining: the Work surface's queues as dense tables when real queue data
  makes the columns worth it, and a Timeline extraction if a second consumer
  ever appears (the treatment is applied in place today).
- Verification: complete en-US and pt-BR catalogs for any new copy, width
  checks against pt-BR (the longer language).

## Stage 4: motion and polish

Deliverable: the motion contract from section 2.5 applied.

- Delivered on 2026-08-24: theme swaps suppress transitions for one frame so
  colors cut over together; badges cross-fade background and color on state
  change (200ms, named properties); the button press scale sits behind
  motion-safe; progress already transitioned width. The attention pulse was
  already motion-safe.
- Not added, deliberately: skeletons (the screen renders from pushed state,
  there is no first-load jank surface today) and any continuous activity
  animation beyond the existing spinner semantics, per the quiet-by-default
  concept.

## Stage 5: operator design rules area

Deliverable: the scaffolding an operator uses to get consistent design across
their own projects, as a Gateship rules area.

- Delivered on 2026-08-24, with no new runtime machinery: the convention is
  `DESIGN.md` at the operator repository's root plus one pointer line in
  `AGENTS.md`, because the agent CLIs already load repository instructions
  into every run (`operator-design-rules.md`). The seed preset is
  `presets/DESIGN.md`, a complete contract derived from this design system
  where the operator swaps accent and faces and keeps the guarantees.
  Gateship consumes its own convention: `AGENTS.md` now points UI work at
  `design-system.md`.
- Deferred, requires its own approved specification (deterministic runtime
  change): typed awareness of the design contract in the product, a rules
  surface in the UI, and any check that a UI diff honored the contract.
- No visual editor, unchanged.

## Stage 6: gateship.dev landing and launch assets

Parked on 2026-08-24: the operator has their own concept for the landing. A
self-contained draft exists as a session artifact (hero on the your-turn
semantic, product frame in HTML, the loop with the two operator moments
marked, the real cohort numbers, install) and serves as raw material when
this stage reopens. OG images, icons and screenshots remain to be produced
with it.

## Risks and dependencies

- R1 (Saans Mono/SemiMono license) blocks Stage 1's ship only if the mono
  enters the theme; mitigation: the free fallback is already planned.
- Stage 3 depends on Stage 2; the other stages are independent of each other.
- Decisions 04 through 12 are provisional: Stage 1 is deliberately small to
  validate them on real screens before the kit consolidates everything.
