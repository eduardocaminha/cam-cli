# Blocks and component sources

Curated map of where to take structural examples from when reworking a
Gateship surface (researched 2026-08-24). Everything arrives as copied code
adapted to Base UI plus this repo's tokens, and nothing enters without
passing `design-system.md`. Motion imports must be state-triggered, short,
and behind `prefers-reduced-motion`; looping or decorative-hover animation is
disqualified at triage.

## Page composition (shells, hierarchy)

- `shadcn-ui/ui` block `dashboard-01`: SidebarProvider, AppSidebar decomposed
  into nav groups, thin SiteHeader, SectionCards (stat row), then a TanStack
  DataTable whose toolbar uses tabs-with-count as view filter and whose row
  click opens a detail drawer. The skeleton for the overview and the runs
  list; the tab-count badge is where the acid marks "waiting on operator".
- `sidebar-07` (collapses to an icon rail) for maximizing detail-page area;
  `sidebar-03` (flat grouped subitems) as the settings layout model.
- There is no official settings or detail-page block; those compose from the
  pieces above.

## Chat (orchestrator conversation)

Two distinct systems, used together:

- shadcn/ui chat primitives (June 2026): `MessageScroller` (anchored turns,
  streaming, thread restore), `Message`, `Bubble`, `Attachment`, `Marker`
  (system/status lines between turns), plus `scroll-fade` and `shimmer`.
  The transcript spine; `Marker` is the natural fit for runtime events
  interleaved with conversation.
- `vercel/ai-elements` (48 typed-part components, shadcn registry): `Tool`
  (collapsible typed command render), `Confirmation` (inline human approval,
  the pinned-question mold), `Task`, `Plan`, `Queue`, `Suggestion` pills,
  `Prompt Input`, and for run detail also `Test Results`, `Commit`,
  `Stack Trace`. Assumes Radix; port patterns to Base UI when adopted.

## Component-level density

- COSS UI (Base UI + Tailwind, Cal.com): 508 particles, no page blocks.
  Take `table` particles (tanstack, filter, sort, search tags), `empty
  state`, `segmented control`, `toolbar`, `meter`, `kbd`.
- 21st.dev: community registry, structure source for dense tables, stat
  tiles (Statistics Card 7/8 by @sean0205), sidebars, settings forms.
  Quality varies; curate hard.

## Motion imports that survive triage

- Magic UI: `Number Ticker` (stat tiles, once, reduced-motion off),
  `Animated List` (activity feed, short stagger, new items only), the
  `Terminal` frame without fake typing (verification output).
- Aceternity: patterns only, reimplemented quiet: `Stateful Button`,
  `Multi Step Loader` (the run pipeline spine), empty-state blocks stripped
  of gradients. The rest of the catalog (WebGL, particles, animated
  backgrounds) is explicitly out for operational surfaces.

## Standing rule

The acid accent never comes from these sources; its semantics are applied on
top through this repo's attention tokens.
