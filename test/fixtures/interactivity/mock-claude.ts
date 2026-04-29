// test/fixtures/interactivity/mock-claude.ts
//
// Mocked `claude` subprocess for the interactivity test suite (US-013). This
// is a deliberately minimal Bun script that:
//
//   1. Reads keystrokes / lines from stdin.
//   2. Emits scripted SSE-style events to stdout (one JSON line per event,
//      mimicking the shape Claude Code's CLI emits in its event stream).
//   3. Honors three operator behaviors:
//        - Esc keypress (raw 0x1B byte): emits an `interrupted` event,
//          terminates the *current* simulated turn, but DOES NOT exit the
//          subprocess (matches real claude — Esc cancels the current turn,
//          you stay in the session and can type the next prompt).
//        - Typed message (line ending with \n on stdin): emits a `user_turn`
//          event reflecting the typed content, then a scripted `assistant`
//          response that echoes the content back with a "[mock-reply]:" marker
//          so tests can assert "the response addresses the typed content".
//        - EOF on stdin: emits a `done` event and exits 0.
//
// The point of having this as a real spawnable script (rather than a
// JS-level fake) is so the interactivity tests can validate end-to-end
// signalling: Bun.spawn's `stdin` actually carries bytes to the
// subprocess's stdin, and the subprocess's stdout actually flows back. A
// pure-JS fake (like the FakeSubprocessHandle used in plan.test.ts) is
// great for protocol logic but cannot exercise the IPC boundary that's
// the load-bearing thing in interactivity preservation.
//
// Behavior contract — kept stable so tests can assert against literal
// strings in the output stream:
//
//   - On startup, emits exactly:
//       {"type":"system","subtype":"ready"}
//   - On Esc (0x1B byte), emits exactly:
//       {"type":"system","subtype":"interrupted"}
//   - On typed line `<msg>\n`, emits exactly:
//       {"type":"user","text":"<msg>"}
//       {"type":"assistant","text":"[mock-reply]: <msg>"}
//   - On EOF, emits exactly:
//       {"type":"system","subtype":"done"}
//
// All output is line-delimited JSON; tests parse line-by-line.

import { stdin, stdout } from 'node:process';

// A single Buffer accumulator for partial chunk reads — we want to detect
// the Esc byte (0x1B) regardless of whether it arrives in its own chunk.
let buffer = Buffer.alloc(0);

function emit(line: string): void {
	stdout.write(line + '\n');
}

function handleChunk(chunk: Buffer): void {
	buffer = Buffer.concat([buffer, chunk]);

	// Walk the buffer one byte at a time. Two events of interest:
	//   1. 0x1B (Esc) — emit an `interrupted` event; the byte is consumed
	//      and we drop any partial input collected up to that point (matches
	//      real claude: Esc cancels the in-progress prompt).
	//   2. \n — line terminator. Everything from buffer[0..\n) is a typed
	//      message; emit user + assistant events and consume that prefix.
	//
	// Anything else stays in the buffer until the next chunk completes a line.
	while (buffer.length > 0) {
		const escIdx = buffer.indexOf(0x1b);
		const newlineIdx = buffer.indexOf(0x0a);

		// Pick whichever delimiter comes first (or neither).
		let nextDelim: number = -1;
		let nextDelimType: 'esc' | 'newline' | null = null;
		if (escIdx >= 0 && (newlineIdx < 0 || escIdx < newlineIdx)) {
			nextDelim = escIdx;
			nextDelimType = 'esc';
		} else if (newlineIdx >= 0) {
			nextDelim = newlineIdx;
			nextDelimType = 'newline';
		}

		if (nextDelim < 0) {
			// No complete event yet — wait for more bytes.
			return;
		}

		if (nextDelimType === 'esc') {
			// Consume and drop everything up to and including the Esc byte.
			emit('{"type":"system","subtype":"interrupted"}');
			buffer = buffer.subarray(nextDelim + 1);
			continue;
		}

		// nextDelimType === 'newline'
		const lineBytes = buffer.subarray(0, nextDelim);
		buffer = buffer.subarray(nextDelim + 1);
		const msg = lineBytes.toString('utf8').replace(/\r$/, '');
		// JSON-escape in the simplest possible way: only `"` and `\` matter
		// for the test fixtures we use; control chars are rejected upstream
		// since the input is always plain ASCII test content.
		const escaped = msg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
		emit(`{"type":"user","text":"${escaped}"}`);
		emit(`{"type":"assistant","text":"[mock-reply]: ${escaped}"}`);
	}
}

function handleEnd(): void {
	emit('{"type":"system","subtype":"done"}');
	// Flush stdout before exit. Bun's process.exit() doesn't always drain
	// stdout buffers when stdout is a pipe; using process.nextTick gives
	// the runtime a tick to flush.
	process.nextTick(() => {
		process.exit(0);
	});
}

// On SIGTERM (the kill-by-parent path), exit cleanly with code 143 to mirror
// the behavior real `claude` exhibits when ralph plan kills its subprocess.
process.on('SIGTERM', () => {
	emit('{"type":"system","subtype":"terminated"}');
	process.nextTick(() => {
		process.exit(143);
	});
});

// Wire stdin reading. We do NOT call setRawMode — the parent test owns the
// TTY semantics. stdin arrives as Buffer chunks here.
stdin.on('data', handleChunk);
stdin.on('end', handleEnd);

// Emit ready event so tests can synchronize on the fixture being live.
emit('{"type":"system","subtype":"ready"}');
