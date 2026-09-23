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
