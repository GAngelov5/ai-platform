import { createTrackerHttpServer } from "./server.js";
import { TrackerStore } from "./store.js";

const token = process.env.TRACKER_TOKEN;
if (!token || token.length < 16) {
  console.error("TRACKER_TOKEN (>= 16 chars) is required");
  process.exit(78);
}
const port = Number(process.env.PORT ?? 8080);
const store = await new TrackerStore(process.env.TRACKER_DATA_FILE ?? "/data/tracker.json").load();
createTrackerHttpServer({ store, token }).listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", msg: "atlas-tracker MCP server listening", port }));
});
