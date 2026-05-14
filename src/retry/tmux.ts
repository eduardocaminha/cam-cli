/**
 * Ported from claude-auto-retry v0.2.2
 * Original authors: cheapestinference contributors
 * Port: Eduardo Caminha
 * License: MIT — see LICENSES/claude-auto-retry-MIT.txt
 */

export function buildCaptureArgs(pane: string, lines = 200): string[] {
  return ["capture-pane", "-t", pane, "-p", "-S", `-${lines}`];
}

export function buildSendKeysArgs(pane: string, text: string): string[] {
  return ["send-keys", "-t", pane, text, "Enter"];
}

export function buildDisplayArgs(pane: string, format: string): string[] {
  return ["display-message", "-t", pane, "-p", format];
}

export function parseTmuxVersion(versionString: string): number {
  const match = versionString.match(/tmux\s+(\d+\.\d+)/);
  return match ? parseFloat(match[1] ?? "0") : 0;
}

export function getTmuxVersion(): number {
  try {
    const result = Bun.spawnSync(["tmux", "-V"], { stdout: "pipe" });
    const out = result.stdout ? new TextDecoder().decode(result.stdout).trim() : "";
    return parseTmuxVersion(out);
  } catch {
    return 0;
  }
}

export async function capturePane(pane: string, lines = 200): Promise<string> {
  const proc = Bun.spawn(["tmux", ...buildCaptureArgs(pane, lines)], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

export async function sendKeys(pane: string, text: string): Promise<void> {
  const proc = Bun.spawn(["tmux", ...buildSendKeysArgs(pane, text)], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

export async function getPaneCommand(pane: string): Promise<string> {
  const proc = Bun.spawn(["tmux", ...buildDisplayArgs(pane, "#{pane_current_command}")], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

export async function isProcessForeground(pid: number): Promise<boolean | null> {
  try {
    const proc = Bun.spawn(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim().includes("+");
  } catch {
    return null;
  }
}

export function isInsideTmux(): boolean {
  return !!process.env["TMUX"];
}

export function getCurrentPane(): string | null {
  return process.env["TMUX_PANE"] ?? null;
}
