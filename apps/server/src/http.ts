import express, { type Application, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { bearer, issueGuestToken, verifyGuestToken } from "./auth.js";
import type { ServerConfig } from "./config.js";
import { log } from "./log.js";
import type { Store } from "./store/index.js";

/** Small fixed-window limiter keyed by client address. */
function rateLimit(perMinute: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { n: 1, reset: now + 60_000 });
      if (hits.size > 10_000) hits.clear();
      return next();
    }
    entry.n++;
    if (entry.n > perMinute) {
      res.status(429).json({ error: "Too many requests — wait a minute and try again" });
      return;
    }
    next();
  };
}

const guestBody = z.object({ name: z.string().trim().min(1).max(20) });
const restaurantBody = z.object({ name: z.string().trim().min(1).max(60) });

/**
 * Application HTTP routes (spec §14): health/readiness, guest sessions, restaurant listing and
 * export. Room creation and joining always go through Colyseus matchmaking routes.
 */
export function mountRoutes(app: Application, config: ServerConfig, store: Store): void {
  app.set("trust proxy", config.trustProxy ? 1 : false);
  app.disable("x-powered-by");

  // Exact-origin CORS for bearer-token requests. No cookies, so no credentialed CORS.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS" && req.path.startsWith("/api/")) {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/readyz", async (_req, res) => {
    const db = await store.healthy();
    res.status(db ? 200 : 503).json({ ok: db, store: store.kind });
  });

  const api = express.Router();
  api.use(express.json({ limit: "8kb" }));

  const requireGuest = async (req: Request, res: Response): Promise<string | null> => {
    const id = verifyGuestToken(config.guestTokenSecret, bearer(req.headers.authorization));
    if (!id || !(await store.getProfile(id.profileId))) {
      res.status(401).json({ error: "Guest session missing or invalid" });
      return null;
    }
    return id.profileId;
  };

  api.post("/guest", rateLimit(10), async (req, res) => {
    const body = guestBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Choose a name between 1 and 20 characters" });
      return;
    }
    try {
      const profile = await store.createProfile(body.data.name);
      const token = issueGuestToken(config.guestTokenSecret, profile.id);
      log.info("guest created", { profile: profile.id });
      res.status(201).json({ profileId: profile.id, name: profile.name, token });
    } catch (err) {
      log.error("guest creation failed", { err: err as Error });
      res.status(503).json({ error: "The save service is unavailable — try again shortly" });
    }
  });

  api.get("/me", rateLimit(120), async (req, res) => {
    const profileId = await requireGuest(req, res);
    if (!profileId) return;
    const profile = await store.getProfile(profileId);
    const restaurants = await store.listRestaurants(profileId);
    res.json({
      profile,
      restaurants: restaurants.map((r) => ({ id: r.id, name: r.name, balanceCents: r.balanceCents, createdAt: r.createdAt })),
    });
  });

  api.post("/restaurants", rateLimit(20), async (req, res) => {
    const profileId = await requireGuest(req, res);
    if (!profileId) return;
    const body = restaurantBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Name your restaurant (1–60 characters)" });
      return;
    }
    const owned = await store.listRestaurants(profileId);
    if (owned.length >= 3) {
      res.status(409).json({ error: "You already have three restaurants" });
      return;
    }
    const r = await store.createRestaurant(profileId, body.data.name);
    res.status(201).json({ id: r.id, name: r.name, balanceCents: r.balanceCents });
  });

  api.get("/restaurants/:id/export", rateLimit(20), async (req, res) => {
    const profileId = await requireGuest(req, res);
    if (!profileId) return;
    const id = String(req.params.id);
    const r = z.string().uuid().safeParse(id);
    const restaurant = r.success ? await store.getRestaurant(id) : null;
    // Only the owner may export; others get the same 404 as a missing restaurant.
    if (!restaurant || restaurant.ownerId !== profileId) {
      res.status(404).json({ error: "Restaurant not found" });
      return;
    }
    const data = await store.exportRestaurant(id);
    res.setHeader("Content-Disposition", `attachment; filename="after-hours-${id}.json"`);
    res.json(data);
  });

  app.use("/api", api);
}
