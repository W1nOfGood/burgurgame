import { loadConfig } from "./config.js";
import { configureLog, log } from "./log.js";
import { createGameServer } from "./app.js";
import { createStore } from "./store/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  configureLog(config.logLevel);
  const store = createStore(config.databaseUrl);
  await store.init();
  if (store.kind === "memory") log.warn("using the in-memory store: progress is lost on restart");
  const server = await createGameServer(config, store);
  server.onShutdown(async () => {
    await store.close();
    log.info("shutdown complete");
  });
  await server.listen(config.port, config.host);
  log.info("game service listening", { port: config.port, host: config.host, store: store.kind, origins: config.allowedOrigins });
}

main().catch((err: Error) => {
  log.error("fatal startup error", { err });
  process.exit(1);
});
