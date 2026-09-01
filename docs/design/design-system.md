# Gateship Design System, Draft 1

> Status: direction approved by the operator on 2026-08-23, with choices marked
> provisional. Scope: the product's visual layer and the foundation for the
> operator design rules area. No runtime behavior changes.
> Living reference mockup: design session file `gateship-direcao-f4.html`,
> variation toggles in pure CSS.

## 1. Concept: quiet by default, acid when it is your turn

The product sells autonomy: healthy activity asks for no attention. The design
translates that into a single color rule:

- A healthy autonomous run is monochrome and quiet. Activity never gets color.
- Acid `#c8ff00` marks exclusively what waits on the operator: an internal
  question, a pending approval, a failure handed back. It is the loudest item
  on any screen it appears on, so nothing else may reach its luminance.
- Color beyond acid exists only as state: success, alert, failed. Canceled is
  always gray (Primer and Linear consensus: cancellation is not an error).

No direct comparable (Devin, Factory, Amp, Conductor) uses this semantic.
They all color activity. A gray dashboard with a single lit item tells the
product's story in one screenshot.

## 2. Foundations

### 2.1 Color

Neutral, both themes, is the coss ui token set
(github.com/cosscom/coss, `packages/ui/src/styles/globals.css`) verbatim
(operator decision, 2026-08-24): a pure Tailwind neutral scale (no olive
tint, still decision 04#1) composed with `--alpha()` and `color-mix()`
instead of hand-picked hex. Attention (the acid family and the focus ring it
drives) and the two typefaces are the only tokens this import does not touch.

Card and background are the same white on light; the border alone separates
them. Dark lifts by a few percent per layer via `color-mix`, not a fixed step.

| Role | Dark | Light |
|---|---|---|
| background | `color-mix(neutral-950 96%, white)` (`#141414`) | `#ffffff` |
| surface (card) | `color-mix(background 98%, white)` (`#191919`) | `#ffffff` |
| control (popover) | `color-mix(background 96%, white)` (`#1d1d1d`) | `#ffffff` |
| well (muted, secondary, hover accent) | white 4% alpha | black 4% alpha |
| sidebar | `color-mix(neutral-950 97%, white)` (`#111111`) | neutral-50 `#fafafa` |
| ink (foreground) | neutral-100 `#f5f5f5` | neutral-800 `#262626` |
| secondary ink (muted-foreground) | neutral-500 mixed 90% white (`#818181`) | neutral-500 mixed 90% black (`#686868`) |
| line (border) | white 10% alpha | black 12% alpha |
| strong line (input) | white 12% alpha | black 16% alpha |

The line alphas run above coss's own 6-10% (operator decision, 2026-08-25):
the mark's stroke is heavy (~2.5px at render size), and hairlines at coss's
strength read as a different, thinner voice next to it. Same 1px width,
more ink.

On the gray canvas the light acid-text ramp deepens to `#546c00` (5.05:1) and
acid-ui measures 3.38:1, still above the 3:1 UI minimum.

Acid and its ramps. Measured contrast (WCAG 2.1):

| Use | Value | Contrast | Rule |
|---|---|---|---|
| fill, dark and light | `#c8ff00` + ink `#161807` | 15.21:1 | the only form of pure acid on light |
| text on dark | `#c8ff00` | 15.55:1 | free on dark |
| text or border on light | `#c8ff00` | 1.10:1 | forbidden |
| acid-text (small text on light) | `#546c00` | 5.05:1 | AA |
| acid-ui (border and icon on light) | `#6b8a00` | 3.38:1 | AA for UI |
| attention surface wash | `#eef7cc` light, `#262b10` dark | with dark ink / acid text | solid, never an alpha |

The focus ring is pure acid in both themes (operator decision on real
screens: the AA ramp read as olive). Known tradeoff: on white controls the
acid ring sits below the 3:1 focus-indicator floor.

States, vivid treatment (decision 10#2), values now the coss ui exact hues
(operator decision, 2026-08-24; contrast not re-measured against the earlier
AA pass, R2 covers re-verifying on real screens):

Each state carries a solid (dots, bars) and a foreground (text); tinted badge
backgrounds derive from the solid at low alpha.

| State | Light solid / text | Dark solid / text |
|---|---|---|
| success | emerald-500 `#10b981` / emerald-700 `#047857` | emerald-500 `#10b981` / emerald-400 `#34d399` |
| alert | amber-500 `#f59e0b` / amber-700 `#b45309` | amber-500 `#f59e0b` / amber-400 `#fbbf24` |
| failed | red-500 `#ef4444` / red-700 `#b91c1c` | red-500 mixed 90% white / red-400 `#f87171` |
| canceled | secondary ink | secondary ink |

No state uses the acid's hue. `merged` (Gateship's own state, no coss
equivalent) stays purple, unchanged by the import. The trend chart's own
gray ramp (`chart-1`..`5`) is also unchanged: `canceled` always renders gray,
and coss's saturated multi-series chart hues do not fit a single quiet line.

State application: badge with tinted background, never a fully colored row.
Semantic color lives in small areas.

### 2.2 Typography

- The interface voice is Saans, and it is the only declared face (operator
  decision, 2026-08-25, removing the vendored Inter fallback). Saans cannot
  ship: the repository and its binaries are public and the Displaay license
  does not grant redistribution, so the file is gitignored and served only
  when present on disk beside a `GSHIP_WEB_DIR` build; a release binary
  embeds no font at all and every other machine falls back to the system
  sans stack. The vectorized wordmark and gateship.dev remain the public
  Saans surfaces.
- Weight floor: 500, inherited by the whole document from `html`, not
  opt-in through a class (operator decision, 2026-08-25, superseding
  decision 12#1's 450: the first ladder read too light beside the mark's
  own ~670 weight, and the floor token was originally never wired to body
  prose at all). Weight ladder, real `--font-weight-*` tokens rather than
  one-off `font-[560]` arbitrary values at each call site: `font-normal`
  500 body, `font-medium` 560 light emphasis and buttons, `font-semibold`
  620 card titles and emphasis spans, `font-bold` 680 page titles, sitting
  beside the wordmark's own weight rather than a class below it. A 600
  floor was tried and inverted the ladder against `font-medium`.
- Size scale: a true modular scale (operator decision, 2026-08-25), minor
  third (1.2), base 16px, also as real `--text-*` tokens (Tailwind's own
  `text-xs`…`text-4xl` names, not a parallel set) rather than Tailwind's
  ad hoc 12/14/16/18/20/24/30/36 ladder: `text-xs` 11px, `text-sm` 13px,
  `text-base` 16px, `text-lg` 19px, `text-xl` 23px, `text-2xl` 28px,
  `text-3xl` 33px, `text-4xl` 40px. A handful of call sites run one step
  below `text-xs` on purpose (10px mono labels, timestamps, counters) and
  stay arbitrary; that is a deliberately smaller register, not a gap in
  the scale.
- The data voice is mono: SHA, branch, duration, cost, count, command, issue
  id. Prose never in mono, data never in sans. The mono slot currently falls
  back to the system stack; a shippable mono face (OFL) may be vendored the
  same way Inter was.
- Wordmark: Saans 670, already vectorized in
  `webui/src/components/gateship-logo.tsx`.

### 2.3 Shape

- Radius is the coss ui scale, verbatim and complete (operator decision,
  2026-08-25): base `0.625rem`, `sm` = base − 4px, `md` = base − 2px,
  `lg` = base, `xl` = base + 4px, and nothing defined past `xl`, so `2xl`
  and up stay Tailwind's own defaults (`2xl` is 1rem), which is exactly
  what coss.com renders on its card frames. Card surfaces sit on
  `rounded-2xl` (16px) with the nested content panel re-rounded to
  `rounded-t-xl` (14px) by the frame; controls (button, input, select,
  tabs list) are `rounded-lg` (10px); badges are `rounded-sm` (6px).
- Buttons are coss's rounded-lg controls, not pills (operator decision,
  2026-08-25, superseding decision 11#2; the whole component kit was
  re-vendored from coss ui's own sources and only the typography, the acid
  family, the offset card ring and the state hues stay Gateship's).
- Action vs status: a button has a border or strong fill on `rounded-lg`; a
  badge has no border, a tinted wash, a smaller body and `rounded-sm`.

### 2.4 Elevation

- coss ui's elevation lives in its component classes, not in tokens, and is
  vendored verbatim (operator decision, 2026-08-25): every surface and
  control carries `shadow-xs/5` plus a 1px `::before` bevel (dark hairline
  below on light, light top edge on dark); solid buttons add a top gloss
  (`inset-shadow` white 16%) and a shadow tinted by their own fill, both
  flattening on press; popovers use `shadow-lg/5`; the active tab indicator
  `shadow-sm/5`. The old `--elevation-*` tokens are gone.
- Gateship's own layer on top: the offset card ring (`card-ring`,
  index.css), a flat 1px ring 7px outside a card surface in coss's own
  `border/64` tone, concentric with the card's radius, with the 7px offset
  counted as the card's own space (`margin: 7px`), so the ring never
  spends layout the grid did not grant (operator decision, 2026-08-26,
  superseding the fading variant: the flat double border reads cleaner
  than the top-heavy gradient). The ring marks belonging, not cardness:
  cards that carry one function together share a single ring on their
  group wrapper (`card-ring-group`, which silences its members' own rings
  and margins -- the Overview stat row, the project grid, the run stat
  pair), and a card alone in its function keeps its own ring as a group
  of one.
- Attention card (acid) keeps its own tinted highlight plus a discreet
  ambient glow (`0 6px 28px` at 7 to 13% alpha), inline on the component,
  because attention is not part of the coss import.

### 2.5 Motion

A contract, not decoration:

- Short and bound to real state. Nothing animates unless data changed.
- A spinner never outlives its request: minimum display time, immediate exit.
- Zero layout shift in lists: rows reserve height, status swaps in place.
- `prefers-reduced-motion` honored across the system.
- Continuous indicators (active run) animate outside the React cycle (CSS),
  no re-render.

## 3. Component kit

Model: coss ui's own component sources (github.com/cosscom/coss,
`packages/ui/src/components`), vendored verbatim into
`webui/src/components/ui` with the imports adapted and lucide icons inlined
as SVG (operator decision, 2026-08-25). Behavior stays on the same Base UI
primitives coss builds on. Gateship keeps its historical export names (Card
here is coss's CardFrame anatomy, CardPanel its nested inner card) so no
call site changed, and layers exactly four things of its own on top: the
typography, the attention family (including the focus ring and the acid
button/badge variants), the offset card ring, and the state hues plus the
`merged` state coss does not have. Icons are Hugeicons
(`@hugeicons/core-free-icons`), drawn on a 24 grid, so every use
compensates the stroke: visual weight is `strokeWidth x size / 24`.

Craft baseline for every component and surface: `interface-cheatsheet.md`
(vendored from interfaces.dev). Where it conflicts with this document, this
document wins.

Build order, with each contract:

1. Button: primary (monochrome, inverted ink), outline, ghost, acid (reserved
   for actions that resolve an attention item), destructive. Every panel's
   constructive primary action -- a form's save, create, register, import,
   promote -- wears the solid ink button (operator decision, 2026-08-25):
   the black fills are what balance the mark's own weight across a screen,
   so they are spent on real primaries, one per panel, never on secondary
   or destructive actions.
2. Badge: state pill with the closed palette of section 2.1. Dot variant
   (saturated 7px dot + neutral text) for dense tables.
3. Card: default surface with head, mono meta and body.
4. AttentionCard: the only acid surface. Pulsing dot, title with mono id,
   actions on the right.
5. Table: rows with mono id, state badge, numeric columns in mono, right
   aligned.
6. Stat: large number in SemiMono 500, label in tertiary sans.
7. Sidebar (operator decision, 2026-08-31): lockup on top, then a two-line
   project switcher in the team-switcher anatomy -- a 32px bordered tile,
   the project name in medium 14px, the run status as a 12px muted second
   line whose acid dot on "Needs you" is the navigation's only acid point,
   and a chevron; with no project in the route the trigger holds a muted
   placeholder. The menu scopes projects only. Below it one unlabeled nav
   (aria "Navigation"): a standing Overview item, then the project
   surfaces when a project is selected; the active item carries a subtle
   fill and weight, no marker, no visible group label. Expanded width is
   16rem, the industry default.
8. Event timeline: fixed-width mono timestamp on the left, text with 540
   emphasis.
9. EmptyState: neutral glyph + one sentence + one CTA. A first-class state,
   never a blank screen.
10. Nested composition: ring-group container grouping cards
    (verify + review, executor + reviewer).

## 4. Screen hierarchy

The webui may be reorganized freely (operator authorization). Direction:

- Content measure (operator decision, 2026-08-25): every surface's content
  lives in a centered 80rem (1280px) column inside the full-width scrolling
  `<main>`, the standard dashboard measure, instead of stretching edge to
  edge on wide displays. Column counts inside the grids are sized against
  that cap. The measure is one token (`--content-measure`) and the operator
  can release it: the shell's top-right controls carry a width toggle,
  stored like the theme and re-applied at boot.
- Inset content panel (operator decision, 2026-08-26): the sidebar and the
  canvas share one `bg-sidebar` ground; the content lives in a rounded
  bordered panel that extends the sidebar to the top and bottom of the
  viewport, and only the panel's `<main>` scrolls. The shell controls ride
  inside the panel.
- Shell preferences (operator decision, 2026-08-25): language, theme and
  width live as one row of outline buttons at the top right of the content
  area, above every surface; each button's face names the state it switches
  to. The sidebar's foot no longer carries segmented pills.
- Every screen answers "what needs me?" first. Attention items sit above the
  active run, above the queue, above statistics.
- Multiproject overview: asymmetric bento with a hero tile "N active runs, M
  waiting on you", per-project tiles with a state dot, cohort statistics in
  SemiMono.
- Project home: the orchestrator conversation as the primary surface, with
  the attention card and active run visible without scrolling.
- Runs: active run card with timeline; previous runs as a dense table.
- Work: queue, proposals and diagnostics as badge lists; proposals never use
  acid (they are advisory, they block nothing).
- Forbidden anti-patterns: decorative charts, more than 4 simultaneous hues,
  density that does not survive pt-BR (~30% longer than en-US), KPIs without
  a baseline.

## 5. Decisions and pending items

Operator decisions of 2026-08-23, provisional until Stage 1 validates them on
real screens: 04#1 pure gray, 07#3 Apple+, 08#3 hairline, 09#1 top
reflection, 10#2 vivid states, 11#2 pill buttons, 12#1 weight floor 450.

Pending:

- R1: no Displaay font (Saans, Saans Mono, SemiMono) may enter the public
  repository or the distributed binaries; redistribution is not licensed, and
  TRIAL files never ship anywhere. Saans usage is confined to the wordmark
  vector and gateship.dev. Mockups on the operator's own machine may use the
  local files.
- R2: validate squircle and pills on the webui's real components (the
  decision was made on a mockup).
- R3: define the landing brand assets (gateship.dev) outside this doc.
- R5: the logo's solid bottom-left offset depth is a candidate brand motif
  for controls, a hard unblurred offset shadow on pressed or attention
  buttons. Prototype during the component-kit stage before adopting.
