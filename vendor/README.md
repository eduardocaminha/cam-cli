# Embedded legacy state template

`cam-loop.local.md.tmpl` is the remaining input to the legacy deterministic
loop-state renderer. `bun run embed-vendor` inlines it into
`src/vendor/_generated.ts`; the drift gate and `test/embedded.test.ts` enforce
byte parity.

The web runtime does not use this asset. It remains only until the legacy
sidecar dependency closure is removed.
