// Optional tool sets. Each plugin is a folder here whose index.ts exports a Plugin; add it to
// PLUGINS below. Users turn plugins on by name in settings.json: { "plugins": ["f3"] }.
// See docs/plugins.md.
import type { Tool } from "../helpers";
import { loadSettings } from "../config";
import { BandError } from "../band";
import f3 from "./f3";

export interface Plugin {
  /** Short id users put in settings.json. */
  name: string;
  /** One line for the README and `status`. */
  description: string;
  tools: Tool[];
  /** Appended to the server's instructions to the model while the plugin is on. */
  instructions?: string;
}

export const PLUGINS: Plugin[] = [f3];

/** Plugins named in settings.json. An unknown name is an error, so typos don't pass silently. */
export function enabledPlugins(): Plugin[] {
  return loadSettings().plugins.map((n) => {
    const p = PLUGINS.find((x) => x.name === n);
    if (!p) throw new BandError("unsupported", `Unknown plugin "${n}" in settings.json. Available: ${PLUGINS.map((x) => x.name).join(", ")}`);
    return p;
  });
}
