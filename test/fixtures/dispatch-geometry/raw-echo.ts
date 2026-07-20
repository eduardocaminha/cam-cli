// test/fixtures/dispatch-geometry/raw-echo.ts
//
// Real-tmux pane fixture for test/integration/dispatch-geometry.test.ts
// (US-002, CAM-359; corrected review round 1 fix, US-R1-001).
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
// On every keystroke the WHOLE composer is redrawn from `ANCHOR_ROW`
// upward: `computeRows` lays the buffer out exactly the way an Ink composer
// with a 2-char prompt ("> ", matching the real measured empty-composer
// baseline `cursorX === 2`) would -- the first row absorbs
// `paneWidth - PROMPT.length` characters after the prompt, every
// subsequent row absorbs a full `paneWidth` characters, and the FINAL row
// is whatever is left over (1..paneWidth characters, resting in a
// "pending wrap" state at the end of that row -- verified separately
// against real tmux: a pty leaves cursor_x AT the row width in a pending
// state until the next byte arrives, never eagerly resting at column 0 of
// a fresh row on its own). Because the first row's capacity is offset by
// the 2-char prompt, a sufficiently long payload lands the trailing
// leftover row's length back at exactly 2 characters -- reproducing, on a
// REAL tmux pane, the exact-collision residue class this fixture exists to
// exercise: cursor_x back at the baseline's column 2, cursor_y unchanged
// (it never moves), while the composer still holds unsent text.
//
//   - On a carriage-return byte (what tmux `send-keys ... Enter` transmits):
//       - argv[2] === 'submit' (default): clears the buffer and redraws the
//         empty-composer baseline, modeling a composer that clears on
//         successful submit.
//       - argv[2] === 'drop': swallows the byte silently, modeling a busy
//         TUI that drops the trailing Enter (the CAM-358 defect this whole
//         oracle exists to catch).
//
// Usage: `bun raw-echo.ts <submit|drop> <paneWidth> <paneHeight>`

const mode = process.argv[2] === 'drop' ? 'drop' : 'submit';
const paneWidth = Number.parseInt(process.argv[3] ?? '80', 10);
const paneHeight = Number.parseInt(process.argv[4] ?? '24', 10);

/** Matches the real measured empty-composer prompt ("> ", cursorX === 2). */
const PROMPT = '> ';

/**
 * Fixed terminal row the cursor always rests on, regardless of how many
 * rows the composer currently occupies (the "grows upward, pinned cursor_y"
 * model this fixture exists to reproduce).
 */
const ANCHOR_ROW = paneHeight - 1;

let buffer = '';

/**
 * Lay `buffer` out into composer rows: row 0 carries the `PROMPT` prefix
 * and absorbs `paneWidth - PROMPT.length` characters; every row after that
 * absorbs a full `paneWidth` characters; the final row is whatever is left
 * (1..`paneWidth` characters, pending-wrap, never 0 for a non-empty
 * buffer).
 */
function computeRows(text: string): string[] {
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
