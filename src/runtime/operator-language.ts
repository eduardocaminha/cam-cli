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
//
// GSHIP-708: the rule that "the language of the request" decides was
// ambiguous while every surrounding workflow instruction is itself English.
// Run 11af175c-18c7-4e00-af84-cfeac93c3d9a had a Portuguese issue record and
// still emitted English `provider.activity` text, so the contract now names
// its source (the Issue record's own natural language) and rules the
// instructions' own language out of the choice. Both prompt builders keep it
// adjacent to the Issue record it points at, in every turn shape.
//
// Two roles hold no Issue record at all -- the cycle question resolver sees a
// finding and prior answers, the conversational orchestrator sees a
// transcript and a brief -- so the contract names the operator-written text
// each of them does carry. Without that fallback, ruling out the
// instructions' own English would leave those turns with no source named.

/** Prose rules for every operator-facing agent text produced during a run. */
export const OPERATOR_LANGUAGE_CONTRACT = [
	'Operator-facing language contract, for every text the operator reads: summary, textual progress, questions, proposals and findings.',
	"Write in the operator's language: the natural language of this run's Issue record, including its title, description and approved spec, and of the operator's most recent guidance or message when this run has one.",
	'When a turn carries no Issue record, take that language from the operator-written text it does carry: the transcript, the project brief, the review finding under discussion or the prior answers.',
	'The language of these workflow instructions never participates in that choice: they are written in English for the tooling, and that is not a reason to write in English.',
	'Keep identifiers, commands, paths, filenames, numbers and URLs exactly as they are; never translate them.',
	'Be concise and use plain language. Organize by topic only when the text needs it.',
	'No emojis, no em dashes, no filler, no praise and no theatricality.',
] as const;
