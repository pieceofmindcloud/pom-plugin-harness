import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { getPluginAsset, usePluginI18n } from "../host/runtime";
import { resizeMessage, terminalUrl } from "../terminal/connection";

/** `ui/runtime.json`: whether herdr and pi are up. The POM proxy knows where. */
type RuntimeStatus = { status: "ready" } | { status: "starting" } | { status: "error"; error: string };

type Phase =
  | { kind: "starting" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "disconnected" }
  | { kind: "error"; message: string };

const POLL_MS = 1000;
const START_TIMEOUT_MS = 180_000;

async function waitUntilReady(signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const runtime = await getPluginAsset<RuntimeStatus>("ui/runtime.json");
    if (runtime.status === "ready") return;
    if (runtime.status === "error") throw new Error(runtime.error);
    if (Date.now() > deadline) throw new Error("timed out waiting for the terminal runtime");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
  }
}

// A dark palette in the POM's hues; herdr and pi draw their own colors on top.
const THEME = {
  background: "#12141e",
  foreground: "#e2e6f0",
  cursor: "#8b7bff",
  selectionBackground: "#5b47eb66",
  black: "#1c1f2b",
  brightBlack: "#5f677e",
};

export function Terminal() {
  const { t } = usePluginI18n();
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const cleanup: Array<() => void> = [];
    setPhase({ kind: "starting" });

    waitUntilReady(controller.signal)
      .then(() => {
        const element = host.current;
        if (controller.signal.aborted || !element) return;
        setPhase({ kind: "connecting" });

        const term = new XTerm({
          cursorBlink: true,
          // herdr owns the right click (its pane and sidebar menus); xterm must not select a word.
          rightClickSelectsWord: false,
          fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
          fontSize: 13,
          scrollback: 5000,
          theme: THEME,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.loadAddon(new WebLinksAddon());
        term.open(element);
        fit.fit();
        cleanup.push(() => term.dispose());
        // xterm forwards the right click to herdr as a mouse event; keep the
        // browser's own context menu from opening over the terminal.
        const suppressMenu = (event: MouseEvent) => event.preventDefault();
        element.addEventListener("contextmenu", suppressMenu);
        cleanup.push(() => element.removeEventListener("contextmenu", suppressMenu));

        const socket = new WebSocket(terminalUrl(term.cols, term.rows));
        socket.binaryType = "arraybuffer";
        cleanup.push(() => socket.close());
        socket.onopen = () => {
          setPhase({ kind: "connected" });
          term.focus();
        };
        socket.onmessage = (event) => {
          term.write(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
        };
        socket.onclose = () => {
          if (!controller.signal.aborted) setPhase({ kind: "disconnected" });
        };
        const input = term.onData((data) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(data);
        });
        const binary = term.onBinary((data) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(Uint8Array.from(data, (char) => char.charCodeAt(0)));
          }
        });
        cleanup.push(() => input.dispose(), () => binary.dispose());

        // Follow the POM content area: fit the grid, then tell herdr the new size.
        const observer = new ResizeObserver(() => {
          fit.fit();
          if (socket.readyState === WebSocket.OPEN) socket.send(resizeMessage(term.cols, term.rows));
        });
        observer.observe(element);
        cleanup.push(() => observer.disconnect());
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      });

    return () => {
      controller.abort();
      for (const dispose of cleanup.reverse()) dispose();
    };
  }, [attempt]);

  const overlay =
    phase.kind === "connected" ? null : phase.kind === "error" ? (
      <div className="pb-status" role="alert">
        <p className="pb-status-title">{t("failed")}</p>
        <p className="pb-status-detail">{phase.message}</p>
        <button type="button" className="pb-action" onClick={retry}>
          {t("retry")}
        </button>
      </div>
    ) : phase.kind === "disconnected" ? (
      <div className="pb-status" role="status">
        <p className="pb-status-title">{t("disconnected")}</p>
        <button type="button" className="pb-action" onClick={retry}>
          {t("reconnect")}
        </button>
      </div>
    ) : (
      <div className="pb-status" role="status">
        <span className="pb-spinner" aria-hidden="true" />
        <p className="pb-status-title">{t(phase.kind === "starting" ? "starting" : "connecting")}</p>
        {phase.kind === "starting" && <p className="pb-status-detail">{t("startingDetail")}</p>}
      </div>
    );

  return (
    <div className="pb-page">
      <div ref={host} className="pb-terminal" />
      {overlay}
    </div>
  );
}
