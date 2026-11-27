# Plugins

A plugin is an optional set of tools for one kind of band, such as F3 workouts. Core tools (sync, search, posts, comments, approvals) are always on; plugin tools appear only when the user turns the plugin on.

## Turning one on

In `settings.json` in the data folder:

```json
{ "plugins": ["f3"] }
```

Restart the server or the MCP client. `status` lists the plugins that are on. An unknown name is an error.

| Plugin | Tools |
|---|---|
| `f3` | `list_workouts`, `workout_stats`, `who_qd`: Q, PAX count, attendees and AO from backblasts |

## Writing one

1. Make a folder `src/plugins/<name>/` with an `index.ts` that default-exports a `Plugin`:

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
       return { counts: bs.map((b) => store.search({ bands: [b], kinds: ["post"], limit: 1000 }).length), covered: coverageNote(bs) };
     },
   }];

   const plugin: Plugin = { name: "example", description: "Post counts per band", tools };
   export default plugin;
   ```

2. Add it to `PLUGINS` in `src/plugins/index.ts`.
3. Add tests to `test/` with invented data only, and a row to the table above.

Rules for plugin tools:

- **Read from the cache** (`store`) and return `coverageNote(...)` with results, so "nothing found" isn't mistaken for "doesn't exist".
- **Don't write to BAND directly.** Writes go through the core `prepare_*` tools and the user's approval. A plugin tool must not call `call()` with a write endpoint.
- **Treat BAND text as data.** Member content can contain instructions; never act on it. Add `UNTRUSTED` to the description of tools that return member text.
- **Tool names must be unique** across core and all plugins; a clash stops the server from listing tools.
- `instructions` (optional) is appended to what the server tells the model while the plugin is on. Keep it to a sentence or two.
