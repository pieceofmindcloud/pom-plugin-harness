// The browser side of the terminal: one WebSocket to the POM plugin proxy,
// which reaches the launcher's pseudo-terminal running the herdr client.
// Keystrokes go out as text frames; `{"type":"resize"}` text frames resize
// the terminal; everything that comes back is terminal output.

declare const __POM_PLUGIN_CODE__: string;

export const PROXY_PREFIX = `/api/ui/plugins/${__POM_PLUGIN_CODE__}/proxy`;

type Page = Pick<Location, "protocol" | "host">;

/** The terminal socket URL on the POM's own origin, carrying the initial size. */
export function terminalUrl(cols: number, rows: number, page: Page = location): string {
  const scheme = page.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${page.host}${PROXY_PREFIX}/terminal?cols=${cols}&rows=${rows}`;
}

export function resizeMessage(cols: number, rows: number): string {
  return JSON.stringify({ type: "resize", cols, rows });
}
