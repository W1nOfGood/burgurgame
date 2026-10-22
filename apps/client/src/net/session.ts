import { Client, type Room } from "@colyseus/sdk";
import {
  MSG,
  PROTOCOL_VERSION,
  RestaurantState,
  SERVER_MSG,
  type InputMessage,
  type PingMessage,
  type ResultMessage,
  type ServedMessage,
  type SummaryMessage,
  type ToastMessage,
  type WelcomeMessage,
} from "@ahb/protocol";
import { storageGet, storageSet } from "../settings.js";
import { realtimeUrl } from "./api.js";

type Handler<T> = (payload: T) => void;

class Emitter<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<Handler<never>>>();
  on<K extends keyof Events>(type: K, fn: Handler<Events[K]>): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(fn as Handler<never>);
    this.handlers.set(type, set);
    return () => set.delete(fn as Handler<never>);
  }
  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    for (const fn of this.handlers.get(type) ?? []) (fn as Handler<Events[K]>)(payload);
  }
}

export interface SessionEvents extends Record<string, unknown> {
  welcome: WelcomeMessage;
  toast: ToastMessage;
  served: ServedMessage;
  ping: PingMessage;
  summary: SummaryMessage;
  drop: { code: number };
  reconnect: undefined;
  leave: { code: number; reason?: string };
  error: { code: number; message?: string };
}

export interface JoinRequest {
  name: string;
  platform: "desktop" | "touch";
  mode?: "relaxed" | "normal";
  restaurantId?: string;
}

const RECONNECT_KEY = "ahb.reconnect";

/** Wraps the Colyseus SDK connection to one restaurant room. */
export class Session extends Emitter<SessionEvents> {
  readonly room: Room<unknown, RestaurantState>;
  welcome: WelcomeMessage | null = null;
  private nextCmd = 1;
  private waiters = new Map<number, (r: ResultMessage) => void>();

  private constructor(room: Room<unknown, RestaurantState>) {
    super();
    this.room = room;
    room.reconnection.maxEnqueuedMessages = 24;
    room.onMessage(SERVER_MSG.welcome, (w: WelcomeMessage) => {
      this.welcome = w;
      this.rememberReconnect();
      this.emit("welcome", w);
    });
    room.onMessage(SERVER_MSG.result, (r: ResultMessage) => {
      const fn = this.waiters.get(r.cmd);
      if (fn) {
        this.waiters.delete(r.cmd);
        fn(r);
      }
    });
    room.onMessage(SERVER_MSG.toast, (t: ToastMessage) => this.emit("toast", t));
    room.onMessage(SERVER_MSG.served, (s: ServedMessage) => this.emit("served", s));
    room.onMessage(SERVER_MSG.ping, (p: PingMessage) => this.emit("ping", p));
    room.onMessage(SERVER_MSG.summary, (s: SummaryMessage) => this.emit("summary", s));
    room.onDrop((code) => this.emit("drop", { code }));
    room.onReconnect(() => {
      this.rememberReconnect();
      this.emit("reconnect", undefined);
    });
    room.onLeave((code, reason) => {
      for (const fn of this.waiters.values()) fn({ cmd: 0, ok: false, reason: "Disconnected" });
      this.waiters.clear();
      if (code === 1000 || code === 4000) storageSet(RECONNECT_KEY, null);
      this.emit("leave", { code, reason });
    });
    room.onError((code, message) => this.emit("error", { code, message }));
  }

  private static client(token: string): Client {
    const client = new Client(realtimeUrl());
    client.auth.token = token;
    return client;
  }

  static async create(token: string, req: JoinRequest): Promise<Session> {
    const room = await Session.client(token).create<RestaurantState>("restaurant", { protocol: PROTOCOL_VERSION, ...req }, RestaurantState);
    return new Session(room);
  }

  static async join(token: string, code: string, req: JoinRequest): Promise<Session> {
    const room = await Session.client(token).joinById<RestaurantState>(code.trim().toUpperCase(), { protocol: PROTOCOL_VERSION, ...req }, RestaurantState);
    return new Session(room);
  }

  /** Resumes after a page reload within the server's reconnect grace period. */
  static async resume(token: string): Promise<Session | null> {
    const raw = storageGet(RECONNECT_KEY);
    if (!raw) return null;
    try {
      const saved = JSON.parse(raw) as { token: string; at: number };
      if (Date.now() - saved.at > 55_000) {
        storageSet(RECONNECT_KEY, null);
        return null;
      }
      const room = await Session.client(token).reconnect<unknown>(saved.token, RestaurantState as never);
      return new Session(room as unknown as Room<unknown, RestaurantState>);
    } catch {
      storageSet(RECONNECT_KEY, null);
      return null;
    }
  }

  rememberReconnect(): void {
    storageSet(RECONNECT_KEY, JSON.stringify({ token: this.room.reconnectionToken, at: Date.now() }));
  }

  get sessionId(): string {
    return this.room.sessionId;
  }

  get state(): RestaurantState {
    return this.room.state;
  }

  get connected(): boolean {
    return !this.room.reconnection.isReconnecting && this.room.connection.isOpen;
  }

  /** Discrete intent with a command id; resolves with the server's result. */
  command(type: string, payload: Record<string, unknown> = {}): Promise<ResultMessage> {
    const cmd = this.nextCmd++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(cmd);
        resolve({ cmd, ok: false, reason: "The server didn't answer in time" });
      }, 6000);
      this.waiters.set(cmd, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.room.send(type, { ...payload, cmd });
    });
  }

  /** Motion is never queued while disconnected: obsolete samples are simply dropped. */
  sendInput(msg: InputMessage): void {
    if (!this.connected) return;
    this.room.send(MSG.input, msg);
  }

  sendControl(type: string, payload: Record<string, unknown>): void {
    if (!this.connected) return;
    this.room.send(type, payload);
  }

  async leave(): Promise<void> {
    storageSet(RECONNECT_KEY, null);
    await this.room.leave(true).catch(() => undefined);
  }
}
