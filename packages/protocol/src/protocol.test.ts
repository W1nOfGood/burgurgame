import { describe, expect, it } from "vitest";
import { Decoder, Encoder } from "@colyseus/schema";
import { createFoodState } from "@ahb/simulation";
import { grabSchema, inputSchema, joinOptionsSchema, placeSchema, PROTOCOL_VERSION } from "./messages.js";
import { readFoodBytes, writeFoodBytes } from "./food.js";
import { ItemState, PlayerState, RestaurantState } from "./state.js";

describe("message validation", () => {
  it("accepts a bounded input batch", () => {
    const ok = inputSchema.safeParse({ samples: [{ seq: 1, mx: 0, mz: 1, yaw: 0.2, pitch: 0.1, buttons: 1 }], hold: 0.6 });
    expect(ok.success).toBe(true);
  });

  it("rejects oversized batches, NaN and out-of-range values", () => {
    const sample = { seq: 1, mx: 0, mz: 1, yaw: 0, pitch: 0, buttons: 0 };
    expect(inputSchema.safeParse({ samples: Array(7).fill(sample) }).success).toBe(false);
    expect(inputSchema.safeParse({ samples: [{ ...sample, mx: Number.NaN }] }).success).toBe(false);
    expect(inputSchema.safeParse({ samples: [{ ...sample, mz: 5 }] }).success).toBe(false);
    expect(inputSchema.safeParse({ samples: [{ ...sample, pitch: Infinity }] }).success).toBe(false);
  });

  it("validates grab and place payloads", () => {
    expect(grabSchema.safeParse({ cmd: 3, item: "i12", rev: 2 }).success).toBe(true);
    expect(grabSchema.safeParse({ cmd: 3, dispenser: "bin_cheese" }).success).toBe(true);
    expect(grabSchema.safeParse({ cmd: 0, item: "i12", rev: 2 }).success).toBe(false);
    expect(grabSchema.safeParse({ cmd: 1, item: "../../etc", rev: 2 }).success).toBe(false);
    expect(placeSchema.safeParse({ cmd: 4, point: { x: 0, y: 0.9, z: 4.4 } }).success).toBe(true);
    expect(placeSchema.safeParse({ cmd: 4, point: { x: 1e9, y: 0.9, z: 4.4 } }).success).toBe(false);
  });

  it("accepts the angles of a player who has turned around many times", () => {
    // Camera yaw accumulates while looking around; after a few full turns every place used to
    // come back "Invalid request".
    const point = { x: 0, y: 0.9, z: 4.4 };
    expect(placeSchema.safeParse({ cmd: 5, point, yaw: Math.PI * 7 }).success).toBe(true);
    expect(placeSchema.safeParse({ cmd: 5, point, yaw: -Math.PI * 31 }).success).toBe(true);
    expect(placeSchema.safeParse({ cmd: 5, point, yaw: Number.NaN }).success).toBe(false);
    const sample = { seq: 1, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0 };
    expect(inputSchema.safeParse({ samples: [sample], rotYaw: Math.PI * 9 }).success).toBe(true);
    expect(inputSchema.safeParse({ samples: [sample], rotYaw: Infinity }).success).toBe(false);
  });

  it("requires the current protocol version to join", () => {
    expect(joinOptionsSchema.safeParse({ protocol: PROTOCOL_VERSION, name: "Sam", platform: "touch" }).success).toBe(true);
    expect(joinOptionsSchema.safeParse({ protocol: PROTOCOL_VERSION + 1, name: "Sam", platform: "touch" }).success).toBe(false);
    expect(joinOptionsSchema.safeParse({ protocol: PROTOCOL_VERSION, name: "", platform: "touch" }).success).toBe(false);
  });
});

describe("state encoding", () => {
  it("round-trips players, items and quantised food through the encoder", () => {
    const state = new RestaurantState();
    state.protocol = PROTOCOL_VERSION;
    const p = new PlayerState();
    p.name = "Avery";
    p.x = 1.25;
    state.players.set("s1", p);
    const item = new ItemState();
    item.kind = "patty";
    const food = createFoodState("patty");
    food.cookA = 0.8;
    food.inner = 0.5;
    writeFoodBytes(item, food);
    state.items.set("i1", item);

    const encoder = new Encoder(state);
    const bytes = encoder.encodeAll();
    const decoded = new RestaurantState();
    const decoder = new Decoder(decoded);
    decoder.decode(bytes);

    expect(decoded.players.get("s1")?.name).toBe("Avery");
    expect(decoded.players.get("s1")?.x).toBeCloseTo(1.25, 5);
    const back = readFoodBytes(decoded.items.get("i1")!);
    expect(back.cookA).toBeCloseTo(0.8, 1);
    expect(back.inner).toBeCloseTo(0.5, 1);
    expect(decoded.items.get("i1")?.zone).toBe(-1);
  });
});
