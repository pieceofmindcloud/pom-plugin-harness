import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { getPluginAsset, usePluginI18n } from "../host/runtime";
import { useScreenReady } from "../host/ready";
import { clipboardShortcut, copyTerminalText, osc52Text } from "../terminal/clipboard";
import { PROXY_PREFIX, resizeMessage, terminalUrl } from "../terminal/connection";

/** `ui/runtime.json`: whether herdr and pi are up. The POM proxy knows where. */
type RuntimeStatus = { status: "ready" } | { status: "starting" } | { status: "error"; error: string };
type AgentsStatus = { state: "installing" | "ready" | "error"; message?: string };

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
  const terminalRef = useRef<XTerm | null>(null);
  const [pendingCopy, setPendingCopy] = useState<string | null>(null);
  const [agentsStatus, setAgentsStatus] = useState<AgentsStatus | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  // The terminal itself is the content of this screen: the host opens it after
  // herdr first renders, or when a failure to show has settled, not while the
  // socket is connected but its client is still attaching.
  useScreenReady(phase.kind === "connected" || phase.kind === "disconnected" || phase.kind === "error");

  useEffect(() => {
    const controller = new AbortController();
    const cleanup: Array<() => void> = [];
    setPhase({ kind: "starting" });
    setPendingCopy(null);
    setAgentsStatus(null);

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
        terminalRef.current = term;
        fit.fit();
        cleanup.push(() => { terminalRef.current = null; term.dispose(); });

        let copyRequest = 0;
        let recentHerdrSelection: { text: string; until: number } | null = null;
        const copy = (text: string, preferAsync = false) => {
          const request = ++copyRequest;
          void copyTerminalText(text, preferAsync).then((copied) => {
            if (!controller.signal.aborted && request === copyRequest) setPendingCopy(copied ? null : text);
          });
        };
        term.attachCustomKeyEventHandler((event) => {
          const selection = recentHerdrSelection && Date.now() < recentHerdrSelection.until ? recentHerdrSelection.text :
            term.hasSelection() ? term.getSelection() : "";
          const shortcut = clipboardShortcut(event, Boolean(selection), navigator.platform);
          if (shortcut === "copy") {
            event.preventDefault();
            recentHerdrSelection = null;
            term.clearSelection();
            copy(selection);
            return false;
          }
          // The browser fires `paste` on xterm's textarea; xterm sends its
          // text as a bracketed paste instead of forwarding Ctrl+V to herdr.
          if (shortcut === "paste") {
            recentHerdrSelection = null;
            return false;
          }
          return true;
        });
        const oscClipboard = term.parser.registerOscHandler(52, (data) => {
          const text = osc52Text(data);
          if (text !== undefined) {
            term.clearSelection();
            recentHerdrSelection = { text, until: Date.now() + 3000 };
            copy(text, true);
          }
          return true;
        });
        cleanup.push(() => oscClipboard.dispose());
        // xterm forwards the right click to herdr as a mouse event; keep the
        // browser's own context menu from opening over the terminal.
        const suppressMenu = (event: MouseEvent) => event.preventDefault();
        element.addEventListener("contextmenu", suppressMenu);
        cleanup.push(() => element.removeEventListener("contextmenu", suppressMenu));

        const socket = new WebSocket(terminalUrl(term.cols, term.rows));
        socket.binaryType = "arraybuffer";
        cleanup.push(() => socket.close());
        let rendered = false;
        socket.onmessage = (event) => {
          term.write(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer), () => {
            if (!rendered && !controller.signal.aborted) {
              rendered = true;
              setPhase({ kind: "connected" });
              term.focus();
            }
          });
        };
        socket.onclose = () => {
          if (!controller.signal.aborted) setPhase({ kind: "disconnected" });
        };
        const input = term.onData((data) => {
          recentHerdrSelection = null;
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

  useEffect(() => {
    if (phase.kind !== "connected") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`${PROXY_PREFIX}/agents`, { signal: controller.signal });
        if (response.ok) {
          const status = await response.json() as AgentsStatus;
          if (!controller.signal.aborted) setAgentsStatus(status);
        }
      } catch {
        // A momentary proxy failure should not hide the terminal.
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 4000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [phase.kind, attempt]);

  const retryCopy = () => {
    if (pendingCopy === null) return;
    void copyTerminalText(pendingCopy).then((copied) => {
      if (copied) {
        setPendingCopy(null);
        terminalRef.current?.focus();
      }
    });
  };

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
      {phase.kind === "connected" && agentsStatus && agentsStatus.state !== "ready" && (
        <div className={`pb-agent-progress${pendingCopy !== null ? " pb-agent-progress-stacked" : ""}`} role="status">
          <span>{t(agentsStatus.state === "error" ? "agentFailed" : "agentInstalling")}</span>
          {agentsStatus.state === "error" && agentsStatus.message && <span className="pb-agent-error">{agentsStatus.message}</span>}
        </div>
      )}
      {pendingCopy !== null && (
        <div className="pb-copy-prompt" role="status">
          <span>{t("copyPending")}</span>
          <button type="button" className="pb-action" onClick={retryCopy}>{t("copy")}</button>
        </div>
      )}
    </div>
  );
}
