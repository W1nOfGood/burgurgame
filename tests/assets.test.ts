import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DISPENSERS, ITEM_KINDS } from "@ahb/data";

/**
 * Guards the Blender-built art shipped in apps/client/public/art (docs/ASSET_PIPELINE.md):
 * a partial or broken asset build should fail here, not silently fall back in players' browsers.
 */
const ART = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "client", "public", "art");

interface Gltf {
  nodes: { name: string; mesh?: number; skin?: number }[];
  meshes: { name: string }[];
  images?: { uri?: string }[];
  buffers: { uri?: string }[];
  skins?: { joints: number[] }[];
}

function gltf(rel: string): Gltf {
  const path = join(ART, rel);
  const doc = JSON.parse(readFileSync(path, "utf8")) as Gltf;
  // Babylon's glTF loader refuses any URI containing "..", so every file must sit beside or below the glTF.
  for (const uri of [...doc.buffers, ...(doc.images ?? [])].map((r) => r.uri ?? "")) expect(uri, `${rel} ${uri}`).not.toContain("..");
  for (const b of doc.buffers) expect(existsSync(join(dirname(path), b.uri!)), `${rel} buffer ${b.uri}`).toBe(true);
  for (const im of doc.images ?? []) expect(existsSync(join(dirname(path), decodeURIComponent(im.uri!))), `${rel} image ${im.uri}`).toBe(true);
  return doc;
}

const names = (doc: Gltf) => new Set(doc.nodes.map((n) => n.name));

describe("authored art", () => {
  it("restaurant: glTF, lightmaps and probes referenced by the manifest exist", () => {
    const manifest = JSON.parse(readFileSync(join(ART, "restaurant", "restaurant.json"), "utf8")) as {
      lightmaps: Record<string, { lightmap: string; ao: string; scale: number }>;
      probes: Record<string, { env: string; min: number[]; max: number[] }>;
    };
    const doc = gltf("restaurant.gltf");
    const nodes = names(doc);
    for (const [group, lm] of Object.entries(manifest.lightmaps)) {
      expect(nodes.has(group), `baked group ${group}`).toBe(true);
      expect(existsSync(join(ART, "restaurant", lm.lightmap))).toBe(true);
      expect(existsSync(join(ART, "restaurant", lm.ao))).toBe(true);
      expect(lm.scale).toBeGreaterThan(0);
    }
    for (const p of Object.values(manifest.probes)) {
      expect(existsSync(join(ART, "restaurant", p.env)), p.env).toBe(true);
      for (let i = 0; i < 3; i++) expect(p.max[i]!).toBeGreaterThan(p.min[i]!);
    }
    expect(Object.keys(manifest.probes).sort()).toEqual(["dining", "kitchen"]);
  });

  it("food: every gameplay item kind has an authored model, plus the sauce drizzle", () => {
    const nodes = names(gltf("food.gltf"));
    for (const kind of ITEM_KINDS) expect(nodes.has(kind), `food model for ${kind}`).toBe(true);
    expect(nodes.has("sauce_drizzle")).toBe(true);
    for (const t of ["beef_seared", "beef_cook", "bun_toasted", "bacon_crisp", "mushroom_seared", "egg_white_set"]) {
      expect(existsSync(join(ART, "food", `${t}.webp`)), t).toBe(true);
    }
  });

  it("props: knobs, drawer, a pan for every bin, tray stack, switch and the OPEN sign", () => {
    const nodes = names(gltf("props.gltf"));
    for (const n of ["knob", "drawer", "tray_stack", "switch_plate", "switch_lever", "open_sign"]) expect(nodes.has(n), n).toBe(true);
    for (const d of DISPENSERS) {
      if (d.requiresDrawer !== undefined || d.kind === "tray") continue;
      expect(nodes.has(`bin_${d.id}`) || nodes.has(d.id), `pan for ${d.id}`).toBe(true);
    }
  });

  it("characters: two skinned hands with finger bones and a skinned crew member", () => {
    const hands = gltf("hands.gltf");
    const hn = names(hands);
    for (const side of ["R", "L"]) expect(hn.has(`hand_${side}`)).toBe(true);
    for (const b of ["forearm", "hand", "thumb_03", "index_03", "middle_03", "ring_03", "pinky_03"]) expect(hn.has(b), b).toBe(true);
    expect(hands.skins?.length).toBe(2);
    const crew = gltf("crew.gltf");
    const cn = names(crew);
    for (const b of ["hips", "spine", "chest", "neck", "head", "thigh_l", "shin_r", "upperarm_l", "forearm_r", "crew_cap"]) expect(cn.has(b), b).toBe(true);
    expect(crew.skins?.length).toBe(1);
  });
});
