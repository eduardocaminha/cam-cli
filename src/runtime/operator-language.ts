// src/runtime/operator-language.ts
//
// One provider-neutral language contract for every agent text an operator
// reads during a run: the executor's summary and proposals, the independent
// reviewer's findings, the review cycle's question resolver and the
// conversational orchestrator's message.
//
// It is applied by prompt, never by post-processing. Gateship does not
// translate, rewrite or reject agent output after it is generated, so this
// block is the whole enforcement mechanism and has to stay short enough to
// survive alongside each role's own instructions.
//
// Provider-neutral by construction: Claude and Codex share one executor
// prompt (`buildWorkPrompt`) and one reviewer prompt (`buildReviewPrompt`),
// and both read this same constant, so neither provider can drift from it.

/** Prose rules for every operator-facing agent text produced during a run. */
export const OPERATOR_LANGUAGE_CONTRACT = [
	'Operator-facing language contract, for every text the operator reads: summary, textual progress, questions, proposals and findings.',
	"Write in the language that predominates in the request and its spec, and in the operator's most recent guidance when this run has one.",
	'Keep identifiers, commands, paths, filenames, numbers and URLs exactly as they are; never translate them.',
	'Be concise and use plain language. Organize by topic only when the text needs it.',
	'No emojis, no em dashes, no filler, no praise and no theatricality.',
] as const;
