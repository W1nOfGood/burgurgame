import { loadConfig } from "./config.js";
import { configureLog, log } from "./log.js";
import { createGameServer } from "./app.js";
import { installShutdown } from "./shutdown.js";
import { createStore } from "./store/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  configureLog(config.logLevel);
  const store = createStore(config.databaseUrl);
  await store.init();
  if (store.kind === "memory") log.warn("using the in-memory store: progress is lost on restart");
  // Our own signal handling (shutdown.ts), not Colyseus': it also covers SIGBREAK, always exits
  // the process afterwards and has a safety timeout.
  const server = await createGameServer(config, store, { gracefullyShutdown: false });
  server.onShutdown(async () => {
    await store.close();
    log.info("shutdown complete");
  });
  installShutdown({ run: () => server.gracefullyShutdown(false) });
  await server.listen(config.port, config.host);
  log.info("game service listening", { port: config.port, host: config.host, store: store.kind, origins: config.allowedOrigins });
}

main().catch((err: Error) => {
  log.error("fatal startup error", { err });
  process.exit(1);
});
