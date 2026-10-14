import { ConfigStore, SETTINGS, SETTINGS_FILE, SHORTCUTS_FILE, resolveSiteMode } from "shared";

const USAGE = "usage: terminal-browser site [auto|mobile|desktop]";

function complain(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return 1;
}

export function siteCommand(args: string[]): number {
  const store = new ConfigStore({ settings: SETTINGS_FILE, shortcuts: SHORTCUTS_FILE });
  if (args.length > 1) return complain(`wrong number of arguments, should be at most 1\n${USAGE}`);
  const [value] = args;
  if (value === undefined) {
    const loaded = store.load();
    for (const error of loaded.errors) process.stderr.write(`terminal-browser:${error}\n`);
    const mode = loaded.settings?.["site.mode"] ?? SETTINGS["site.mode"].default;
    const resolved = resolveSiteMode(mode, process.env);
    process.stdout.write(mode === resolved ? `${mode}\n` : `${mode} (${resolved})\n`);
    return 0;
  }
  const parsed = SETTINGS["site.mode"].schema.safeParse(value);
  if (!parsed.success) return complain(`unknown site mode: ${value}\n${USAGE}`);
  try {
    store.setSetting("site.mode", parsed.data);
  } catch (error) {
    return complain(error instanceof Error ? error.message : String(error));
  }
  return 0;
}
