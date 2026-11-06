import { agents } from "./config.js";
import { startTickerIngest } from "./pusher-ingest.js";
import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
createServer().listen(port, () => console.log(`[server] listening on :${port}`));

if (process.env.PUSHER_KEY) {
  const agent = agents[process.env.INGEST_AGENT_KEY ?? ""];
  if (!agent) throw new Error("INGEST_AGENT_KEY must reference an entry in INTEGRATION_AGENTS");
  if (!agent.scopes.includes("market:write")) throw new Error("Ingest agent needs the market:write scope");

  const stop = startTickerIngest({
    key: process.env.PUSHER_KEY,
    cluster: process.env.PUSHER_CLUSTER ?? "mt1",
    symbols: (process.env.TICKER_SYMBOLS ?? "").split(",").filter(Boolean),
    ctx: { agent, project: process.env.INGEST_PROJECT ?? "default" },
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
}
