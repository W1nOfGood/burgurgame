import { storageGet, storageSet } from "../settings.js";

/** Realtime origin: build-time configured, otherwise the dev default on port 2567. */
export function realtimeUrl(): string {
  const configured = import.meta.env.VITE_REALTIME_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, "");
  const params = new URLSearchParams(location.search);
  const override = params.get("realtime");
  if (override) return override.replace(/\/$/, "");
  return `${location.protocol}//${location.hostname}:2567`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { token?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body) headers["Content-Type"] = "application/json";
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let res: Response;
  try {
    res = await fetch(`${realtimeUrl()}${path}`, { ...init, headers, credentials: "omit" });
  } catch {
    throw new ApiError("Can't reach the game server. Check your connection and try again.", 0);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `Server error (${res.status})`, res.status);
  return body as T;
}

const TOKEN_KEY = "ahb.guest.token";
const NAME_KEY = "ahb.guest.name";

export interface GuestSession {
  token: string;
  name: string;
}

export function storedGuest(): GuestSession | null {
  const token = storageGet(TOKEN_KEY);
  const name = storageGet(NAME_KEY);
  return token && name ? { token, name } : null;
}

export function forgetGuest(): void {
  storageSet(TOKEN_KEY, null);
}

/** Uses the stored guest credential if it is still valid, otherwise creates a new guest. */
export async function ensureGuest(name: string): Promise<GuestSession> {
  const stored = storedGuest();
  if (stored) {
    try {
      await request("/api/me", { token: stored.token });
      storageSet(NAME_KEY, name);
      return { token: stored.token, name };
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
    }
  }
  const created = await request<{ token: string; name: string }>("/api/guest", { method: "POST", body: JSON.stringify({ name }) });
  storageSet(TOKEN_KEY, created.token);
  storageSet(NAME_KEY, name);
  return { token: created.token, name };
}

/** Restores a guest identity from a recovery code (the guest credential itself). */
export async function recoverGuest(code: string, name: string): Promise<GuestSession> {
  await request("/api/me", { token: code.trim() });
  storageSet(TOKEN_KEY, code.trim());
  storageSet(NAME_KEY, name);
  return { token: code.trim(), name };
}

export async function exportRestaurant(token: string, restaurantId: string): Promise<Blob> {
  const data = await request<unknown>(`/api/restaurants/${restaurantId}/export`, { token });
  return new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
}
