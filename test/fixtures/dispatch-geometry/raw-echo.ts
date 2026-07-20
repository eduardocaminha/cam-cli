// test/fixtures/dispatch-geometry/raw-echo.ts
//
// Real-tmux pane fixture for test/integration/dispatch-geometry.test.ts
// (US-002, CAM-359; corrected review round 1 fix, US-R1-001; corrected AGAIN
// for the real collision shape, US-002, CAM-364).
//
// A raw-stdin receiver that models an Ink-style composer's cursor behavior
// closely enough to exercise the geometry oracle end to end, WITHOUT
// depending on a real `claude` binary.
//
// Model (corrected, US-R1-001): a real claude TUI, measured directly, pins
// the composer's active (cursor) row at a CONSTANT terminal row regardless
// of how many rows the composer currently occupies -- the box grows UPWARD
// from a fixed bottom anchor, rather than the cursor's row advancing
// downward as text wraps. cursor_x, not cursor_y, is the only positional
// signal that moves. This replaces an earlier version of this fixture that
// modeled an EAGER downward wrap (explicit `\r\n` on row-fill, cursor_y
// incrementing): that model does not hold for a real Ink composer and its
// AC8 test consequently passed for a reason absent in production (see the
// module header of src/tmux/dispatch.ts for the full defect writeup).
//
// CHAR-WRAP mode ('char', default, UNCHANGED by CAM-364): on every keystroke
// the WHOLE composer is redrawn from `ANCHOR_ROW` upward: `computeRowsChar`
// lays the buffer out exactly the way an Ink composer with a 2-char prompt
// (matching the real measured empty-composer baseline `cursorX === 2`) would
// -- the first row absorbs `paneWidth - PROMPT.length` characters after the
// prompt, every subsequent row absorbs a full `paneWidth` characters, and
// the FINAL row is whatever is left over (1..paneWidth characters, resting
// in a "pending wrap" state at the end of that row -- verified separately
// against real tmux: a pty leaves cursor_x AT the row width in a pending
// state until the next byte arrives, never eagerly resting at column 0 of a
// fresh row on its own). Because the first row's capacity is offset by the
// 2-char prompt, a sufficiently long payload lands the trailing leftover
// row's length back at exactly 2 characters -- but this is NOT the shape a
// real Ink TUI produces (see below); it is retained here ONLY because
// AC6/AC7/AC8 and the 2*paneWidth test (review round 1 fix, US-R1-001) were
// written against it and CAM-364's AC4 requires their behaviour to stay
// unmodified.
//
// WRONG COLLISION SHAPE, corrected by CAM-364: the char-wrap model above
// reproduces a collision where the cursor row RETAINS 2 real leftover
// characters of the payload (e.g. a 2*paneWidth-length payload leaves a
// 2-character remainder row). That is exactly why a `MIN_PAYLOAD_TAIL_MATCH
// = 2` content backstop (US-R1-001) appeared to work in this test suite --
// it was matching a shape that does not occur in production. Measured
// against a real claude Ink TUI (v2.1.215, 80x30 pane, 2026-07-20; see
// src/tmux/dispatch.ts module header for the full writeup), the real
// wrap-boundary collision instead leaves the cursor row genuinely BLANK (0
// visible characters once tmux's capture-pane strips trailing whitespace),
// with the prompt AND the payload's own remnant sitting ONE ROW UP, and the
// cursor still resting at column `PROMPT.length` (2) -- the SAME column the
// genuinely empty composer baseline uses. The trigger is a payload ending in
// a SPACE that lands exactly on the word-wrap boundary: real Ink word-wraps
// (never char-wraps) a trailing space onto the next row rather than
// rendering it at the edge of the row it would otherwise fill.
//
// WORD-WRAP mode ('word', new, US-002 CAM-364): `computeRowsWord` reproduces
// this real collision shape. Row capacity is `paneWidth - 2*PROMPT.length`
// (reserving `PROMPT.length` columns at the tail of every row, mirroring the
// `PROMPT.length`-wide indent applied to continuation rows below) rather
// than the char-wrap model's `paneWidth - PROMPT.length`. A payload that
// exactly fills that capacity plus one trailing space wraps: the filler
// stays on the row above (prefixed by the real prompt on row 0, or the
// indent on a later row), and the LONE trailing space that would have
// landed on the next row is dropped rather than rendered -- that next row
// carries only the `PROMPT.length`-wide indent, which capture-pane reports
// as blank (pure trailing whitespace) while the real terminal cursor still
// rests at column `PROMPT.length`. Any other overflow (more than one
// leftover character, or a leftover that doesn't end in a lone space) hard-
// wraps normally with that same indent; this fixture does not attempt to
// reproduce Ink's full internal word-wrap arithmetic for every neighbouring
// length, only the exact load-bearing boundary this fix exists to close.
//
// Measured trailing-space sweep (real claude Ink TUI, 80-wide pane,
// 2026-07-20; payload = filler chars + exactly one trailing space, `len` =
// total payload length, `x` = resulting cursor_x): `len=75 -> x=77` (fits,
// no wrap), `len=76 -> x=78` (fits exactly, no wrap), `len=77 -> x=2,
// COLLISION` (the wrap-boundary case this fixture's word-wrap mode
// reproduces exactly), `len=78 -> x=5` (one character further into
// overflow; this fixture's simplified capacity model computes a nearby but
// not bit-identical value for this specific neighbour -- only `len=77`'s
// collision shape is load-bearing for the discriminator under test, and
// that shape is exact).
//
//   - On a carriage-return byte (what tmux `send-keys ... Enter` transmits):
//       - argv[2] === 'submit' (default): clears the buffer and redraws the
//         empty-composer baseline, modeling a composer that clears on
//         successful submit.
//       - argv[2] === 'drop': swallows the byte silently, modeling a busy
//         TUI that drops the trailing Enter (the CAM-358 defect this whole
//         oracle exists to catch).
//
// Usage: `bun raw-echo.ts <submit|drop> <paneWidth> <paneHeight> <char|word>`

const mode = process.argv[2] === 'drop' ? 'drop' : 'submit';
const paneWidth = Number.parseInt(process.argv[3] ?? '80', 10);
const paneHeight = Number.parseInt(process.argv[4] ?? '24', 10);
const wrapMode = process.argv[5] === 'word' ? 'word' : 'char';

/**
 * Matches the real production prompt: the Ink prompt glyph (U+276F, `❯`)
 * followed by a non-breaking space (U+00A0), preserving the 2-column
 * empty-composer baseline (`cursorX === 2`) measured against a real claude
 * Ink TUI (US-002, CAM-364; replaces the ASCII `'> '` placeholder used
 * before this collision-shape correction).
 */
const PROMPT = '\u276F\u00A0';

/**
 * Fixed terminal row the cursor always rests on, regardless of how many
 * rows the composer currently occupies (the "grows upward, pinned cursor_y"
 * model this fixture exists to reproduce).
 */
const ANCHOR_ROW = paneHeight - 1;

let buffer = '';

/**
 * Lay `buffer` out into composer rows using CHAR-WRAP (the pre-CAM-364
 * model, unchanged): row 0 carries the `PROMPT` prefix and absorbs
 * `paneWidth - PROMPT.length` characters; every row after that absorbs a
 * full `paneWidth` characters; the final row is whatever is left (1..
 * `paneWidth` characters, pending-wrap, never 0 for a non-empty buffer).
 */
function computeRowsChar(text: string): string[] {
	const firstCap = paneWidth - PROMPT.length;
	if (text.length <= firstCap) return [PROMPT + text];
	const rows = [PROMPT + text.slice(0, firstCap)];
	let rest = text.slice(firstCap);
	while (rest.length > paneWidth) {
		rows.push(rest.slice(0, paneWidth));
		rest = rest.slice(paneWidth);
	}
	rows.push(rest);
	return rows;
}

/** Row content capacity for word-wrap mode (see module header). */
function wordWrapCapacity(): number {
	return paneWidth - PROMPT.length * 2;
}

/**
 * Lay `buffer` out into composer rows using WORD-WRAP (US-002, CAM-364; see
 * module header for the measured real-Ink collision this reproduces): row 0
 * carries the `PROMPT` prefix, continuation rows carry a `PROMPT.length`-
 * wide blank indent instead. Both absorb up to `wordWrapCapacity()`
 * characters. A LONE trailing space left over after filling every prior row
 * to capacity is dropped rather than rendered, leaving the final row with
 * only its indent -- blank once tmux strips trailing whitespace on capture,
 * cursor resting at column `PROMPT.length` (the collision this mode exists
 * to exercise).
 */
function computeRowsWord(text: string): string[] {
	const cap = wordWrapCapacity();
	const indent = ' '.repeat(PROMPT.length);
	if (text.length <= cap) return [PROMPT + text];
	const rows = [PROMPT + text.slice(0, cap)];
	let rest = text.slice(cap);
	while (rest.length > cap) {
		rows.push(indent + rest.slice(0, cap));
		rest = rest.slice(cap);
	}
	rows.push(rest === ' ' ? indent : indent + rest);
	return rows;
}

/** Dispatch to the active wrap model (US-002, CAM-364). */
function computeRows(text: string): string[] {
	return wrapMode === 'word' ? computeRowsWord(text) : computeRowsChar(text);
}

/** Redraw the whole screen so the composer's last row lands on ANCHOR_ROW. */
function render(): void {
	const rows = computeRows(buffer);
	const startRow = Math.max(0, ANCHOR_ROW - (rows.length - 1));
	let out = '\x1b[2J\x1b[H';
	out += '\r\n'.repeat(startRow);
	out += rows.join('\r\n');
	process.stdout.write(out);
}

const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (enabled: boolean) => void };
if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
stdin.resume();

// Boot baseline: empty composer, prompt-only row at ANCHOR_ROW.
render();

stdin.on('data', (chunk: Buffer) => {
	for (const byte of chunk) {
		if (byte === 0x0d || byte === 0x0a) {
			if (mode === 'submit') {
				buffer = '';
				render();
			}
			// drop mode: swallow silently, buffer/render unchanged.
			continue;
		}
		buffer += String.fromCharCode(byte);
		render();
	}
});

stdin.on('end', () => {
	process.exit(0);
});
