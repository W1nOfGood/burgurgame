import { MemoryStore } from "./memory.js";
import { PostgresStore } from "./postgres.js";
import type { Store } from "./types.js";

export * from "./types.js";
export { MemoryStore } from "./memory.js";
export { PostgresStore } from "./postgres.js";

export function createStore(databaseUrl: string | null): Store {
  return databaseUrl ? new PostgresStore(databaseUrl) : new MemoryStore();
}
