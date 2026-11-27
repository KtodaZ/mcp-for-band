// Dev helper: run one write executor directly on your private test band (BAND_MCP_TEST_BAND),
// skipping the approval journal. Refuses any other band. Use a band only you are in.
//   try-write.ts <action> '<payload json>'
// Attachments: {"media": [{"path": "C:/x.jpg"}]} is hashed here (kind from the extension).
import * as writes from "../src/writes";
import * as media from "../src/media";
import { registerExecutors } from "../src/executors";
import { disconnect } from "../src/chrome";

const TEST_BAND = Number(process.env.BAND_MCP_TEST_BAND);
if (!TEST_BAND) throw new Error("Set BAND_MCP_TEST_BAND to a private band only you are in");
const [action, json] = process.argv.slice(2);
const p = JSON.parse(json!) as writes.WritePayload & { media?: { path: string }[] };
if (p.bandNo !== TEST_BAND || (p.target && !p.target.split(":")[1]?.startsWith(String(TEST_BAND)))) throw new Error("test band only");
if (p.media?.length) {
  const paths = p.media.map((m) => m.path);
  p.media = await media.attachments(paths.filter((x) => !/\.(mp4|mov|m4v)$/i.test(x)), paths.filter((x) => /\.(mp4|mov|m4v)$/i.test(x)));
}
registerExecutors();
try {
  console.log(JSON.stringify(await writes.executorFor(action as writes.WriteAction)!({} as writes.WriteRow, p as writes.WritePayload)));
} finally {
  await disconnect();
}
