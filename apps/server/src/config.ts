import { randomBytes } from "node:crypto";

export interface ServerConfig {
  production: boolean;
  port: number;
  host: string;
  /** Exact browser origins allowed for HTTP (CORS) and WebSocket upgrades. */
  allowedOrigins: string[];
  guestTokenSecret: string;
  databaseUrl: string | null;
  /** Upper bound on simultaneously active restaurant rooms in this process. */
  maxRooms: number;
  trustProxy: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Test-only hooks (teleport) for automated browser tests. Refused in production. */
  testHooks: boolean;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === "production";
  const origins = (env.ALLOWED_ORIGINS ?? (production ? "" : "http://localhost:5173,http://127.0.0.1:5173"))
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (production && origins.length === 0) {
    throw new Error("ALLOWED_ORIGINS must list the exact frontend origin(s) in production");
  }
  let secret = env.GUEST_TOKEN_SECRET ?? "";
  if (secret.length < 32) {
    if (production) throw new Error("GUEST_TOKEN_SECRET must be at least 32 characters in production");
    secret = randomBytes(32).toString("hex");
  }
  const databaseUrl = env.DATABASE_URL?.trim() || null;
  if (production && !databaseUrl && !bool(env.ALLOW_MEMORY_STORE, false)) {
    throw new Error("DATABASE_URL is required in production (set ALLOW_MEMORY_STORE=1 only for throwaway demos)");
  }
  const testHooks = bool(env.ENABLE_TEST_HOOKS, false);
  if (production && testHooks) throw new Error("ENABLE_TEST_HOOKS must never be set in production");
  const level = (env.LOG_LEVEL ?? "info") as ServerConfig["logLevel"];
  return {
    production,
    port: Number(env.PORT ?? 2567),
    host: env.HOST ?? "0.0.0.0",
    allowedOrigins: origins,
    guestTokenSecret: secret,
    databaseUrl,
    maxRooms: Number(env.MAX_ROOMS ?? 20),
    trustProxy: bool(env.TRUST_PROXY, production),
    logLevel: ["debug", "info", "warn", "error"].includes(level) ? level : "info",
    testHooks,
  };
}
