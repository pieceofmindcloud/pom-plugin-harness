type I18nHook = () => { t: (key: string) => string };

declare const __POM_PLUGIN_CODE__: string;

type PomHost = {
  api: { get<T>(path: string): Promise<T> };
  hooks: {
    useI18n: I18nHook;
  };
};

function host(): PomHost {
  const value = (globalThis as typeof globalThis & { __POM_HOST__?: PomHost }).__POM_HOST__;
  if (!value) throw new Error("POM host SDK is not installed");
  return value;
}

export function useI18n(): ReturnType<I18nHook> {
  return host().hooks.useI18n();
}

export function usePluginI18n(): ReturnType<I18nHook> {
  const { t } = useI18n();
  const pluginCode = __POM_PLUGIN_CODE__;
  return { t: (key: string) => t(`${pluginCode}.${key}`) };
}

/** GET one of this plugin's assets through the POM's authenticated api client. */
export function getPluginAsset<T>(path: string): Promise<T> {
  return host().api.get<T>(`/api/ui/plugins/${__POM_PLUGIN_CODE__}/assets/${path}`);
}

type Rpc = <T>(op: string, params?: unknown) => Promise<T>;
type LoaderReply = { action: "delivered" | "failed"; error?: string };
type LoaderText = { title?: string; message?: string };

/** POM's loader and installer over this plugin's screen (host version 7). */
type HostLoader = {
  show: (request?: LoaderText) => Promise<LoaderReply>;
  progress: (request: LoaderText & { progress: number }) => Promise<LoaderReply>;
  error: (request: LoaderText & { message: string; retry?: boolean }) => Promise<LoaderReply>;
  success: (request?: LoaderText) => Promise<LoaderReply>;
  hide: () => Promise<LoaderReply>;
};

type ScopedApi = {
  rpc?: Rpc;
  loader?: HostLoader;
  events?: { subscribe: (type: string, handler: () => void) => () => void };
};

function scoped(): ScopedApi | null {
  const current = (globalThis as typeof globalThis & {
    __POM_HOST__?: { plugin?: (code: string) => ScopedApi };
  }).__POM_HOST__;
  return typeof current?.plugin === "function" ? current.plugin(__POM_PLUGIN_CODE__) : null;
}

/** The host SDK version: 4 RPC, 6 `ready()`, 7 the loader. */
export function hostVersion(): number {
  return (globalThis as typeof globalThis & { __POM_HOST__?: { version?: number } }).__POM_HOST__?.version ?? 1;
}

/** Calls the plugin's `rpc.<op>` (host version 4). */
export function rpc<T>(op: string, params?: unknown): Promise<T> {
  const call = scoped()?.rpc;
  return typeof call === "function" ? call<T>(op, params) : Promise.reject(new Error("this POM version has no plugin RPC"));
}

const noLoader = (): Promise<LoaderReply> => Promise.resolve({ action: "failed", error: "host_unavailable" });

/**
 * POM draws the loader and the installer; the plugin only says what is going
 * on. While the plugin holds one of these states its screen stays covered;
 * `hide()` or the end of `success()` opens it.
 */
export const loader: HostLoader = {
  show: (request = {}) => scoped()?.loader?.show(request) ?? noLoader(),
  progress: (request) => scoped()?.loader?.progress(request) ?? noLoader(),
  error: (request) => scoped()?.loader?.error(request) ?? noLoader(),
  success: (request = {}) => scoped()?.loader?.success(request) ?? noLoader(),
  hide: () => scoped()?.loader?.hide() ?? noLoader(),
};

/** "Try again" on the loader's error (`loader.retry`). Returns the unsubscribe function. */
export function onLoaderRetry(handler: () => void): () => void {
  const api = scoped();
  if (api?.events) return api.events.subscribe("loader.retry", handler);
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ protocol?: string; type?: string; target?: string }>).detail;
    if (detail?.protocol !== "pom-plugin-events/v1" || detail.type !== "loader.retry") return;
    if (detail.target === "*" || detail.target === __POM_PLUGIN_CODE__) handler();
  };
  window.addEventListener("pom:plugin-event", listener);
  return () => window.removeEventListener("pom:plugin-event", listener);
}
