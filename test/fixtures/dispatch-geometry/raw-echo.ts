// test/fixtures/dispatch-geometry/raw-echo.ts
//
// Real-tmux pane fixture for test/integration/dispatch-geometry.test.ts
// (US-002, CAM-359).
//
// A raw-stdin receiver that models an Ink-style composer's cursor behavior
// closely enough to exercise the geometry oracle end to end, WITHOUT
// depending on a real `claude` binary:
//
//   - Reads stdin in raw mode (no kernel tty echo/line-editing) and echoes
//     each printable byte itself, so the pane's cursor genuinely advances as
//     text arrives (mirrors a composer rendering keystrokes).
//   - Tracks its own column against the pane width (passed as argv[3]) and,
//     the moment a row fills, emits an explicit `\r\n` to move to column 0
//     of the next row -- an EAGER wrap, chosen deliberately over relying on
//     the pty's own deferred-wrap behavior (verified separately: real tmux
//     leaves cursor_x AT the pane width in a "pending wrap" state until the
//     next byte arrives, never resting at column 0 of the next row on its
//     own). Ink manages its own layout via explicit redraws rather than
//     hardware auto-wrap, so an eager, explicit wrap is the closer model of
//     the composer this fixture stands in for, and it is what lets a
//     wrap-boundary-length payload persist a cursor reading at column 0 of a
//     new row -- the exact collision case AC8 requires.
//   - On a carriage-return byte (what tmux `send-keys ... Enter` transmits):
//       - argv[2] === 'submit' (default): clears the screen and homes the
//         cursor to (0, 0), modeling a composer that clears on successful
//         submit.
//       - argv[2] === 'drop': swallows the byte silently, modeling a busy
//         TUI that drops the trailing Enter (the CAM-358 defect this whole
//         oracle exists to catch).
//
// Usage: `bun raw-echo.ts <submit|drop> <paneWidth>`

const mode = process.argv[2] === 'drop' ? 'drop' : 'submit';
const paneWidth = Number.parseInt(process.argv[3] ?? '80', 10);

let column = 0;

const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (enabled: boolean) => void };
if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
stdin.resume();

// Boot baseline: clear the screen and home the cursor to (0, 0).
process.stdout.write('\x1b[2J\x1b[H');

stdin.on('data', (chunk: Buffer) => {
	for (const byte of chunk) {
		if (byte === 0x0d || byte === 0x0a) {
			if (mode === 'submit') {
				process.stdout.write('\x1b[2J\x1b[H');
				column = 0;
			}
			// drop mode: swallow silently, no output, column unchanged.
			continue;
		}
		process.stdout.write(Buffer.from([byte]));
		column++;
		if (column >= paneWidth) {
			process.stdout.write('\r\n');
			column = 0;
		}
	}
});

stdin.on('end', () => {
	process.exit(0);
});
