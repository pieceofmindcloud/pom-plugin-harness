// Let the browser own Windows/Linux clipboard shortcuts while keeping Ctrl+C
// available to interrupt the agent when nothing is selected in xterm.
export function clipboardShortcut(event: Pick<KeyboardEvent, "type" | "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">, hasSelection: boolean, platform: string): "copy" | "paste" | undefined {
  if (/Mac|iPad|iPhone/i.test(platform) || event.type !== "keydown" || !event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return undefined;
  const key = event.key.toLowerCase();
  if (key === "v") return "paste";
  if (key === "c" && hasSelection) return "copy";
  return undefined;
}

/** Herdr sends selected text via OSC 52; xterm does not copy that to the browser by itself. */
export function osc52Text(data: string): string | undefined {
  const separator = data.indexOf(";");
  if (separator < 0 || data.slice(0, separator) !== "c") return undefined;
  const encoded = data.slice(separator + 1);
  if (!encoded || encoded === "?" || encoded.length > 1_400_000) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/** Copy also on HTTP origins where the modern Clipboard API is unavailable. */
export async function copyTerminalText(text: string, preferAsync = false): Promise<boolean> {
  const modern = async () => {
    try {
      if (!navigator.clipboard?.writeText) return false;
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };
  if (preferAsync && await modern()) return true;

  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("aria-hidden", "true");
  input.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0";
  document.body.appendChild(input);
  let copied = false;
  try {
    input.focus({ preventScroll: true });
    input.select();
    copied = document.execCommand("copy");
  } catch {
    // Browser clipboard permissions vary by origin and user gesture.
  } finally {
    input.remove();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  }
  return copied || (!preferAsync && await modern());
}
