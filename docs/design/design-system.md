# Gateship design system

The interface is quiet while work is autonomous and becomes visually explicit
only when the operator must act. These rules are the single design contract for
the web UI.

## Foundations

- Use the system sans stack. Use the system monospace stack only for identifiers,
  commands, timestamps, durations, costs and counters. The existing vector
  wordmark is the only branded lettering.
- Keep neutral canvases and surfaces in both themes. `#c8ff00` is reserved for
  operator attention and its focus family. Success, warning, failure and merged
  use their semantic green, amber, red and purple families. Cancelled stays gray.
- Use the token ladder in `webui/src/index.css`. Components consume semantic
  tokens rather than literal theme colors.
- Cards use the shared rounded surface, hairline border and restrained inset
  highlight. Controls use the smaller shared radius. Status badges are compact
  and never replace a textual label.
- Card siblings are composed with `CardStack` or `CardGrid`: standard stacks,
  grids, split columns and main sections use 24px; metric grids and card-panel
  content use 16px. `CardGrid` owns equal-height cards and collapses to one
  column before its declared responsive columns. Forms use `FormStack` at 12px
  between fields and `FormField` at 4px between label, control and help.
- `CardHeader` uses 24px horizontal and 16px vertical inset. `CardPanel` uses
  24px inset and its 16px internal stack; `Stat`, `AttentionCard` and compact
  operational states use 16px inset. The shared card ring remains 7px.
- Keep one centered content measure by default. The width preference may release
  that cap, but content must remain readable and grids must still collapse.

## Components

Components in `webui/src/components/ui` belong to Gateship. Base UI supplies
behavioral primitives where they remove custom interaction code; Tailwind owns
styling. Hugeicons supplies the icon set.

- A panel has one constructive primary action. Secondary and destructive actions
  remain visually distinct.
- Attention cards are the only acid surfaces and only appear for work waiting on
  the operator.
- Empty states contain a short explanation and a useful next action when one is
  available. Do not render an empty framed region.
- Tables are for comparable rows. Cards are for tasks or explanations. Decorative
  charts and sparse outcome lines are not part of the product.
- State must never be communicated by color alone. Pair color with text, shape or
  another visible cue.

## Surfaces and navigation

- `/overview` summarizes all projects.
- `/projects/:projectId` opens the project Runs surface.
- `/projects/:projectId/runs`, `/work` and `/settings` keep execution, planning
  and configuration separate; `/projects/:projectId/runs` remains an accepted
  address.
- The project selector changes project scope; the navigation changes the current
  surface. Plain links remain the routing mechanism.
- Every screen places operator attention before autonomous activity, history and
  statistics. Pull requests, CI and merged state remain visible in the run view.
- Ajustes exposes the operator-maintained project brief as the durable handoff
  between external-agent sessions; it does not render an internal conversation
  or generated handoff panel.
- On desktop, the sidebar begins with the Control center navigation item. Its
  footer places Global settings before a quiet, non-interactive Gateship
  signature: the official small foreground wordmark and a secondary version.
  The collapsed desktop rail is compact operational navigation: it keeps the
  Control center, project selector and selected project's icon-only surfaces in
  that order, then Global settings before the centered small mark. Icon-only
  destinations keep their accessible label, tooltip and active background; the
  project selector carries the attention signal. Neither signature is a second
  route to the Control center.

## Responsive behavior

- At 390px, the header is compact and every navigation destination remains
  reachable. The desktop sidebar becomes horizontal navigation rather than a
  stacked column.
- Cards and metric grids collapse to one column. Run details use the full
  content width without overlapping fixed or sticky panels.
- Interactive targets provide at least a 44px coarse-pointer hit area. Labels may
  wrap instead of being clipped.
- Only the content panel scrolls on desktop. On small screens, navigation may
  scroll horizontally while the active item stays reachable.

## Interaction and accessibility

- Preserve semantic elements, keyboard navigation, the skip link and visible
  focus rings.
- Pressable controls respond immediately with a short shadow or transform change.
  Do not animate routine navigation or use `transition: all`.
- Live output stays pinned only while the operator is already at the live edge.
- Under `prefers-reduced-motion: reduce`, remove movement and keep only immediate
  or short opacity feedback. Theme changes never cross-fade individual tokens.
- Both `en-US` and `pt-BR` must remain complete. Layouts must tolerate the longer
  catalog without truncating essential actions.
