# Design contract

> Seed preset derived from the Gateship design system. Copy this file to your
> repository root as `DESIGN.md`, replace the SWAP blocks with your brand
> values, and keep the guarantees: they are written against roles, so they
> survive any reskin. Point your `AGENTS.md` at this file for UI work.

## 1. Color roles

Every component uses semantic tokens, never raw values at the call site.

| Role | Meaning | Light | Dark |
|---|---|---|---|
| background | the page canvas | `#f2f2f2` | `#151515` |
| card | a surface one step above the canvas | `#f9f9f9` | `#1b1b1b` |
| control | a small risen item: button, input, popover | `#ffffff` | `#232323` |
| well | a recessed area: muted fills, tracks | `#e7e7e7` | `#232323` |
| ink | primary text | `#181818` | `#f0f0f0` |
| ink-secondary | supporting text | `#5f5f5f` | `#a6a6a6` |
| line | borders | `rgba(0,0,0,.09)` | `rgba(255,255,255,.09)` |
| accent (SWAP) | the brand color, see section 2 | `#c8ff00` | `#c8ff00` |

Light is a gray canvas, not a white page: white is reserved for what rises.
Dark is not light inverted: surfaces lift by a few percent per layer, and
elevation comes from line and highlight, not shadow.

## 2. The accent is a meaning, not a decoration

The accent carries exactly one semantic. In Gateship's case: "this waits on
you". Choose one meaning for your product and enforce it: the accent never
appears on healthy, self-advancing activity, and no other color may reach its
prominence. An accent that appears everywhere means nothing anywhere.

If your accent fails contrast on light surfaces (measure it), define ramps:
a `-ui` step for borders and icons (at least 3.0:1 against the canvas) and a
`-text` step for small text (at least 4.5:1). The pure accent then appears on
light only as a fill under dark ink.

## 3. State colors

States are a closed set with fixed hues, applied as badges and dots, never as
fully painted rows. Canceled is neutral, not red: cancellation is not an
error.

| State | Light solid / text | Dark solid / text |
|---|---|---|
| success | `#16a34a` / `#0a6e2e` | `#22c55e` / `#4ade80` |
| alert | `#d97706` / `#8a5800` | `#f59e0b` / `#fbbf24` |
| failed | `#dc2626` / `#bd1f1f` | `#ef4444` / `#f87171` |
| canceled | ink-secondary | ink-secondary |

Status changes never rely on color alone: pair the color with a label or an
icon.

## 4. Contrast floors (measured, not assumed)

- Body and small text: 4.5:1 against the surface it actually renders on.
- Large text (18px+ or 14px bold): 3.0:1.
- UI parts that must be perceived (borders of inputs, icons, focus rings):
  3.0:1.
- Measure against the real background (a badge's tint, a card's gray), not
  the page background.

## 5. Typography (SWAP the faces, keep the rules)

- One interface face (Gateship ships Inter Variable) and one mono face.
- Mono is the data voice: identifiers, hashes, durations, costs, counts,
  commands. Prose never in mono, data never in sans.
- `font-variant-numeric: tabular-nums` on every value that changes.
- Weight floor 450; hierarchy by a weight ladder, not by color alone.

## 6. Shape and elevation

- One radius base with a multiplier scale; cards on the large slot.
- Fully rounded elements (pills) are never squircles: a superellipse
  flattens their end caps.
- Elevation on light: whiter surface plus a soft hairline shadow. Elevation
  on dark: lighter surface plus a line and a 1px inner top highlight. Never
  heavy dark shadows on dark surfaces.

## 7. Motion contract

- Short, and bound to real state: nothing animates unless data changed.
- Name transition properties; never `transition: all`.
- A spinner never outlives its request.
- Zero layout shift in lists: rows reserve height, status swaps in place.
- Honor `prefers-reduced-motion` everywhere.

## 8. Anti-patterns (forbidden)

- Decorative charts, gradients or glow inside operational surfaces.
- More than four simultaneous state hues on one screen.
- Accent used as generic decoration.
- Blank empty regions: an empty state carries one sentence and at most one
  action.
- Density that does not survive translation (pt-BR runs ~30% longer than
  en-US) or real data (long ids, missing values, outliers).

## 9. Checklist for any UI change

1. New colors are tokens with a role, added to section 1.
2. Text passes the floors of section 4 on its real background.
3. The accent's semantic (section 2) is not diluted.
4. States use the closed set of section 3 with a non-color pair.
5. Motion follows section 7.
6. Both themes checked; neither is the other inverted.
