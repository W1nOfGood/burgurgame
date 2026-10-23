import { boot, type ColyseusTestServer } from "@colyseus/testing";
import { Client, type Room } from "@colyseus/sdk";
import { PROTOCOL_VERSION, type ResultMessage, type RestaurantState } from "@ahb/protocol";
import { issueGuestToken } from "../auth.js";
import { createGameServer, ROOM_NAME } from "../app.js";
import { loadConfig, type ServerConfig } from "../config.js";
import { configureLog } from "../log.js";
import type { RestaurantRoom } from "../room/RestaurantRoom.js";
import { MemoryStore } from "../store/memory.js";
import type { Store } from "../store/types.js";

export const TEST_PORT = 2568;
export const SECRET = "test-secret-".padEnd(48, "x");

export interface Harness {
  colyseus: ColyseusTestServer;
  store: Store;
  config: ServerConfig;
}

export async function startHarness(store: Store = new MemoryStore()): Promise<Harness> {
  configureLog("error", { silent: true });
  const config = loadConfig({ NODE_ENV: "test", GUEST_TOKEN_SECRET: SECRET, ALLOWED_ORIGINS: "http://localhost:5173" });
  await store.init();
  const server = await createGameServer(config, store, { gracefullyShutdown: false });
  const colyseus = await boot(server, TEST_PORT);
  return { colyseus, store, config };
}

export interface TestPlayer {
  sdk: Client;
  profileId: string;
  token: string;
  name: string;
  room: Room<any, RestaurantState>;
  results: Map<number, ResultMessage>;
  waiters: Map<number, (r: ResultMessage) => void>;
  nextCmd: number;
  messages: { type: string; payload: unknown }[];
}

export async function guest(h: Harness, name: string): Promise<Omit<TestPlayer, "room">> {
  const profile = await h.store.createProfile(name);
  const token = issueGuestToken(h.config.guestTokenSecret, profile.id);
  const sdk = new Client(`ws://localhost:${TEST_PORT}`);
  sdk.auth.token = token;
  return { sdk, profileId: profile.id, token, name, results: new Map(), waiters: new Map(), nextCmd: 1, messages: [] };
}

function wire(p: TestPlayer): TestPlayer {
  p.room.onMessage("result", (r: ResultMessage) => {
    p.results.set(r.cmd, r);
    p.waiters.get(r.cmd)?.(r);
  });
  p.room.onMessage("*", (type, payload) => {
    p.messages.push({ type: String(type), payload });
  });
  return p;
}

export async function createRoom(h: Harness, name = "Avery", extra: Record<string, unknown> = {}): Promise<TestPlayer> {
  const g = await guest(h, name);
  const room = await g.sdk.create<RestaurantState>(ROOM_NAME, { protocol: PROTOCOL_VERSION, name, platform: "desktop", ...extra });
  return wire({ ...g, room });
}

export async function joinRoom(h: Harness, code: string, name = "Blake", platform: "desktop" | "touch" = "touch"): Promise<TestPlayer> {
  const g = await guest(h, name);
  const room = await g.sdk.joinById<RestaurantState>(code, { protocol: PROTOCOL_VERSION, name, platform });
  return wire({ ...g, room });
}

export function serverRoom(h: Harness, p: TestPlayer): RestaurantRoom {
  return h.colyseus.getRoomById(p.room.roomId) as unknown as RestaurantRoom;
}

/** Sends a command-id intent and resolves with the server's result. */
export function send(p: TestPlayer, type: string, payload: Record<string, unknown> = {}): Promise<ResultMessage> {
  const cmd = p.nextCmd++;
  return sendWithCmd(p, cmd, type, payload);
}

export function sendWithCmd(p: TestPlayer, cmd: number, type: string, payload: Record<string, unknown> = {}): Promise<ResultMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no result for ${type} #${cmd}`)), 4000);
    p.waiters.set(cmd, (r) => {
      clearTimeout(timer);
      p.waiters.delete(cmd);
      resolve(r);
    });
    p.room.send(type, { ...payload, cmd });
  });
}

export function waitFor<T = unknown>(p: TestPlayer, type: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} message`)), timeoutMs);
    const off = p.room.onMessage(type, (payload: T) => {
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}

export async function until(cond: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends a continuous control repeatedly (like a dragging client) until the condition holds. */
export async function drag(p: TestPlayer, type: string, payload: Record<string, unknown>, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out dragging ${type}`);
    p.room.send(type, payload);
    await new Promise((r) => setTimeout(r, 30));
  }
}
