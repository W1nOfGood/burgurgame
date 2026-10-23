import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { initPhysics } from "@ahb/simulation";
import type { ServerConfig } from "./config.js";
import { mountRoutes } from "./http.js";
import { log } from "./log.js";
import { RestaurantRoom } from "./room/RestaurantRoom.js";
import type { Store } from "./store/index.js";

export const ROOM_NAME = "restaurant";

/**
 * Builds the Colyseus server: one process, WebSocket transport, application routes, exact-origin
 * checks for HTTP matchmaking and WebSocket upgrades. Signal handling is not Colyseus' (unless
 * asked): the process entry point installs shutdown.ts.
 */
export async function createGameServer(config: ServerConfig, store: Store, opts: { gracefullyShutdown?: boolean } = {}): Promise<Server> {
  const R = await initPhysics();
  log.info("rapier initialised", { version: R.version() });
  RestaurantRoom.configure({ store, config, R });

  const allowed = (origin: string | null) => (origin ? config.allowedOrigins.includes(origin) : !config.production);

  // The SDK's matchmaking requests use credentials mode "include", so the exact configured
  // frontend origin gets credentialed CORS; every other origin gets a non-matching origin and no
  // credentials (never a wildcard).
  matchMaker.controller.getCorsHeaders = (headers: Headers): Record<string, string> => {
    const origin = headers.get("origin");
    if (origin && config.allowedOrigins.includes(origin)) {
      return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
    }
    return { "Access-Control-Allow-Origin": config.allowedOrigins[0] ?? "", "Access-Control-Allow-Credentials": "false", Vary: "Origin" };
  };

  const transport = new WebSocketTransport({
    // Heartbeat well below the proxy's 90 s read timeout.
    pingInterval: 10_000,
    pingMaxRetries: 3,
    maxPayload: 16 * 1024,
    beforeUpgrade: (request: Request) => {
      if (!allowed(request.headers.get("origin"))) return new Response("Origin not allowed", { status: 403 });
      return undefined;
    },
  } as ConstructorParameters<typeof WebSocketTransport>[0]);

  const server = new Server({
    transport,
    greet: false,
    gracefullyShutdown: opts.gracefullyShutdown ?? false,
    express: (app) => mountRoutes(app, config, store),
  });
  server.define(ROOM_NAME, RestaurantRoom);
  return server;
}
