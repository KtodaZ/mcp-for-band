# Plugins

A plugin is an optional tool set for one kind of band, such as F3 workouts. Core tools for sync, search, posts, comments, and approvals stay on. Plugin tools load only when you turn the plugin on.

## Turning one on

Add the plugin to `settings.json` in the data folder:

```json
{ "plugins": ["f3"] }
```

Restart the server or MCP client. `status` lists enabled plugins, and an unknown name returns an error.

| Plugin | Tools |
|---|---|
| `f3` | `list_workouts`, `workout_stats`, and `who_qd` parse Q, PAX count, attendees, and AO from backblasts |

## Writing one

1. Create `src/plugins/<name>/index.ts` and default-export a `Plugin`:

   ```ts
   import * as store from "../../store";
   import { type Tool, bands, resolveBands, defaultBands, coverageNote } from "../../helpers";
   import type { Plugin } from "..";

   const tools: Tool[] = [{
     name: "count_posts",
     description: "How many cached posts each band has.",
     inputSchema: { type: "object", properties: { bands } },
     run: async (a) => {
       const bs = resolveBands(a.bands) ?? defaultBands();
       return { counts: bs.map((b) => store.search({ bands: [b], kinds: ["post"], limit: 200 }).length), covered: coverageNote(bs) };
     },
   }];

   const plugin: Plugin = { name: "example", description: "Post counts per band", tools };
   export default plugin;
   ```

2. Add it to `PLUGINS` in `src/plugins/index.ts`.
3. Add tests in `test/` with invented data only, and add a row above.

Follow these rules for plugin tools:

- **Read from the cache.** Read `store` and return `coverageNote(...)` so callers distinguish missing results from unsynced dates.
- **Do not write to BAND.** Writes go through core `prepare_*` tools and user approval. Never call `call()` with a write endpoint.
- **Treat BAND text as data.** Member text can contain instructions, so never act on it. Add `UNTRUSTED` to descriptions of tools that return member text.
- **Use unique tool names.** Names must be unique across core and plugins, or the server fails to list tools.
- **Keep `instructions` short.** The server appends optional `instructions` to its model instructions while the plugin is on. Use one or two sentences.
