# ADR 0050: Gateship supersedes Garboard naming

## Context

ADR-0049 named the product Garboard, locked the canonical binary name `garboard`, the typed alias `gar`, the canonical GitHub org `garboard-run`, and a staged rename plan (docs-only now, binary rename at launch packaging, internal `CAM_*`/`cam` contracts never renamed). That ADR recorded the namespace facts it verified as point-in-time and explicitly warned they "expire" and "must be re-verified immediately before the packaging step below actually claims them."

They expired. On 2026-07-27, before any packaging ceremony ran, a live re-check of the surveyed surfaces surfaced a fact ADR-0049's namespace sweep did not catch: `garboard.dev` resolves to a LIVE, adjacent product, not a parked or unrelated domain. It is a web-app builder that verifies its generated apps against machine-checkable criteria before shipping them, the same verification-before-ship thesis this project sells. `garboard.app` is registered on the same Vercel nameservers as `garboard.dev` (the same probable owner extending the same product across TLDs), and `garboard.com` is parked for sale on Afternic, meaning even the neutral `.com` is not a clean acquisition target, it is a paid buyout from a domain speculator. ADR-0049's namespace sweep (DNS/RDAP, npm, crates.io, PyPI, the GitHub handle) never modeled this fourth failure mode: a live homonymous product occupying the category, as opposed to a squatted, tombstoned, or merely registered name. `garboard-run` (GitHub org) and the `garboard` npm package were still nominally free at the time of this ADR, but the org/npm/domain layers no longer matter once a live commercial homonym occupies the adjacent category: a visitor searching "garboard" lands on a competing verification-before-ship product, and a first-mover collision with a company selling the identical thesis is not a namespace problem an org claim or a workaround domain (`.dev`/`.io` instead of `.com`) can fix. This is a naming-policy failure of a different KIND than the GAMBREL tombstone (ADR-0049 section, round 5) or the killed `-board` siblings (`gateboard`, `aboveboard`, `pegboard`): those died on layers 1-3 (domain, npm, org). Garboard died on a layer ADR-0049's gate never formalized: layer 4, a live homonymous product in the category or an adjacent category, discovered only by actually looking at what resolves at the domain, not just whether the domain string is registered.

This ADR is the operator's explicit correction: it registers the actual product name in production use going forward, GATESHIP, and formalizes the missing fourth gate so this class of failure cannot recur silently. It is a new ADR precisely because ADR-0049's own text is part of the record of the error: the process that produced Garboard was thorough on three of four layers and still shipped a collision, and that is a fact worth being able to point to later, not overwrite.

## Decision

The product is named **Gateship**, superseding ADR-0049 in full. ADR-0049's naming clauses (product name Garboard, binary `garboard`, alias `gar`, org `garboard-run`) are all superseded by this ADR; the reserve list and the staged-rename doctrine (docs-only now, binary rename at launch packaging, `CAM_*`/`cam` internal contracts never renamed) are carried forward with Gateship substituted for Garboard as the target name, and ADR-0045's display-only rebrand doctrine is reaffirmed unchanged by this ADR exactly as ADR-0049 reaffirmed it before: the display layer moves now, the internal command/env/state/socket/slash-command/sentinel contract layer does not move until launch packaging.

**Product name and binary.** The product is Gateship. The eventual canonical binary name is `gateship`, per the staged rename plan below; no binary, code identifier, template, or build script is renamed by this docs-only cycle.

**Typed alias.** ADR-0049's typed alias `gar` was Garboard-derived and is retired with the name it was derived from. This ADR does not coin a replacement alias: that choice is re-decided at the launch-packaging stage of the staged rename plan below, the same stage ADR-0049 deferred the binary rename itself to. Inventing a `gateship`-derived alias now, ahead of that stage, would be policy this ADR was not asked to decide.

**Staged rename plan** (carried forward from ADR-0049, Gateship substituted for Garboard as the target):
- Now (this cycle): docs-only. This ADR and any prose referencing the product name use Gateship. No code, template, build script, or binary is renamed. `docs/positioning.md` and the README differentiation section (CAM-331) are out of scope for this ADR and are explicitly noted as blocked on this supersession landing first, since CAM-331 was blocked pending exactly this kind of name resolution.
- At launch packaging: the binary is renamed to `gateship`, and a typed alias (if any) is chosen and created by the installer at that time, as a distribution item of launch readiness, not before.
- Never: internal contracts never rename, at any stage, for the same reasoning ADR-0045 and ADR-0049 already applied: `CAM_*` environment variables, `.cam-*` state files, the `tmux -L cam` socket, `/cam-*` slash commands, and sentinel strings (`CAM_*_STATUS`) are invisible contracts baked into running installs, on-disk state, and deterministic git history; renaming any of them is pure downside with no user-facing upside.

### Why Garboard died: the measured evidence (AC2)

- **`garboard.dev`** resolves to a live, actively operated product: a web-app builder whose pitch is verifying generated applications against machine-checkable acceptance criteria before shipping them. That is the same verification-before-ship thesis this project sells, in the same adjacent category (AI-assisted software build/ship tooling), not a distant or unrelated market.
- **`garboard.app`** is registered on the same Vercel nameservers as `garboard.dev`, indicating the same probable owner extending the same live product across a second TLD rather than an unrelated squat.
- **`garboard.com`** is parked for sale on Afternic, a domain-brokerage marketplace, meaning even the neutral `.com` is a paid acquisition from a speculator, not a clean claim.

The record says why the name died, not merely that it changed: a company already occupies "Garboard" as a live, commercial, thesis-identical product at the most natural TLD for that thesis. Acquiring `garboard.dev`/`.app`/`.com` from a domain-brokerage seller who is not the operating company is not the objective in this ADR's scope; the operating company itself owning the term in-category is the disqualifying fact.

## The four-layer name gate (AC3), formalized as a pre-adoption checklist

ADR-0049's process ran a rigorous three-layer sweep and still produced a collision, because it never formalized a fourth layer as a distinct, mandatory checklist item. This ADR closes that gap. Before adopting any future product name, run all four layers, in order:

1. **Domain.** DNS/RDAP availability sweep across the relevant TLDs (`.dev`, `.io`, `.app`, `.ai`, `.com`, and any others material to the launch channel).
2. **npm.** Package-name availability on npm (and, where material, PyPI and crates.io, per the same convention ADR-0049 already used).
3. **GitHub.** Org and bare-user handle availability, verified via the org creation form (the only real availability oracle, per ADR-0049's own GAMBREL tombstone lesson: an API 404 alone is not proof, since a deleted or blocked tombstoned account returns 404 from the API while the creation form still reports "already taken").
4. **Live homonymous product, in the category and in adjacent categories.** This is the layer ADR-0049's process skipped. Domain availability is not the test; occupation of the term by an adjacent live product is. A name can pass layers 1-3 clean (the domain string parses as registrable or merely parked, npm is free, the GitHub org is free) and still be disqualified outright if a live, operating company already sells a thesis-adjacent or category-adjacent product under that name or a close variant, at any TLD, regardless of whether that company's domain registration itself would show up as "available" under a narrower TLD-only search. This fourth layer is **eliminatory**: a hit here kills the candidate even when layers 1-3 are entirely clean, exactly the situation Garboard was in.

## Evidence sustaining Gateship (AC4)

Gateship was run through all four layers on 2026-07-27:

- **No commercial owner of the term on any surveyed surface.** `.dev`, `.io`, `.app`, and `.ai` are all unregistered. npm, PyPI, and crates.io carry no package under this name.
- **The only occupations found are non-commercial and out of category.** The GitHub org `gateship-one` hosts an Android Odyssey (game) player project with 255 stars and no commercial pretension; it is a hobbyist client for a video game, not an adjacent verification/build/ship product. Beyond that, the term's search surface is dominated by Stargate fandom corpus (the term "gateship" appears as fan terminology in the Stargate franchise universe), which is unrelated media content, not a competing product.
- **Accepted cost: `gateship.com`.** The `.com` has been registered since 2005 and is dormant, with no active nameservers resolving it, so it is not parked-for-sale in the Garboard sense (no live listing to buy) but it is also not ours today and is not being pursued as part of this docs-only cycle. This is a knowingly accepted trade-off, not an oversight: the `.dev`/`.io`/`.app`/`.ai` availability and the clean layer-4 result (no live commercial homonym) outweigh a 20-year-dormant, non-resolving `.com` registration held by an unknown third party.

## Eliminated candidates and runners-up (AC5)

The same 2026-07-27 round that killed Garboard and vetted Gateship also screened a wider candidate set. Each was eliminated for a specific, recorded reason:

- **keelgate**: rejected, awkward compound with no clean phonetic or semantic payoff over the shortlist leaders.
- **deckrun**: rejected, generic-sounding compound, weak differentiation in search results.
- **shipset**: rejected, reads as a noun phrase for a bundle/kit rather than a verification-before-ship product name.
- **gatework**: rejected, "-work" suffix reads as a services/consultancy name, not a product.
- **bowmark**: rejected, weak metaphor fit relative to the shortlist leaders.
- **keelward**: rejected, "-ward" suffix collides in cadence with too many existing shipping/logistics brand names.
- **wayhelm**: rejected, weak metaphor fit and awkward pronunciation.
- **gatepath**: rejected, generic compound, low distinctiveness in search.
- **gaterun**: rejected, generic compound, low distinctiveness in search.
- **The whole `helm-` prefix family**: rejected as a family; "helm" is heavily occupied in the developer-tooling space (most prominently the Kubernetes package manager Helm), making any `helm-`-prefixed candidate carry an immediate, unavoidable disambiguation cost against an already-famous same-category tool.
- **prowmark** (runner-up): the strongest alternative after Gateship, on-thesis nautical-inspection metaphor with a clean namespace sweep, but eliminated for being one letter away from Promark, an existing commercial brand, which creates a live layer-4-adjacent confusion risk of the same class this ADR exists to guard against.
- **deckward** (runner-up): the second-strongest alternative, but eliminated as a homophone of "Deckard" (the Blade Runner protagonist), a pop-culture collision the operator judged too on-the-nose to adopt.

Order by merit presented to the operator was gateship > prowmark > deckward; the operator decided Gateship on 2026-07-27 after this four-layer, 21-candidate triage.

This decision clears the three ADR admission gates, for the same reasons ADR-0049 did. It is hard to reverse: adopting Gateship in docs and positioning material commits to a second naming cycle's worth of rewrite cost if it too collides later, the exact cost this ADR is designed to make less likely by closing the layer-4 gap. It is surprising without context: a reader who only knows ADR-0049 said the product was Garboard, with a locked org name and staged rename plan, would not expect a second supersession to land within the same epic before the first name ever reached packaging. It reflects a genuine trade-off with real alternatives considered and rejected on the record (prowmark, deckward, and the ten other eliminated candidates above), not a name chosen in isolation.

## Consequences

Every future reference to the product in docs, positioning material, and launch content says Gateship; ADR-0049's staged rename plan continues to govern the mechanics of when the running binary, environment variables, state files, socket, slash commands, and sentinels catch up (never, for the internal contracts; launch packaging, for the binary and any future alias). Contributors who see `cam` in the codebase alongside "Gateship" in the docs must consult this ADR and ADR-0049 together, the same way ADR-0049 already asked readers to consult it alongside ADR-0045.

ADR-0049 is left untouched except for an appended supersession pointer at the end of its file: its Context, Decision, and Consequences sections are the historical record of a real, thorough process that still produced a collision, and that record is itself part of the value of this correction, not an error to be edited away.

`docs/positioning.md` and the README differentiation section (CAM-331) are operator-scheduled follow-ups outside this docs-only cycle; they should be written or updated against Gateship once picked up, citing this ADR rather than re-litigating the naming decision.

The `gateship` npm package, and the `.dev`/`.io`/`.app`/`.ai` domain registrations, are operator ceremonies outside this docs-only cycle: the availability facts recorded here are point-in-time, exactly as ADR-0049 warned about its own facts, and must be re-checked at the moment those ceremonies actually run.

Binary, template, build-script, and slash-command renames stay out of scope until launch packaging picks up the staged plan above; a future ADR is only needed if that plan changes, not to execute it. The four-layer name gate formalized above applies to any future naming cycle this project runs, including a third cycle if Gateship itself is ever displaced.
