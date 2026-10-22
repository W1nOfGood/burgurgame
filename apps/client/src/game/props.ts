import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { MaterialLibrary } from "./materials.js";

/**
 * Non-interactive set dressing that makes the restaurant read as a real place. Every prop is
 * merged into one mesh per material, so the whole pass costs a few dozen draw calls.
 */
class Batch {
  private groups = new Map<PBRMaterial, Mesh[]>();
  add(mat: PBRMaterial, mesh: Mesh): void {
    mesh.bakeCurrentTransformIntoVertices();
    const list = this.groups.get(mat) ?? [];
    list.push(mesh);
    this.groups.set(mat, list);
  }
  flush(prefix: string): Mesh[] {
    const out: Mesh[] = [];
    let i = 0;
    for (const [mat, meshes] of this.groups) {
      const merged = meshes.length === 1 ? meshes[0]! : Mesh.MergeMeshes(meshes, true, true)!;
      merged.name = `${prefix}_${i++}`;
      merged.material = mat;
      merged.isPickable = false;
      merged.receiveShadows = true;
      merged.metadata = { placeholder: true };
      merged.freezeWorldMatrix();
      out.push(merged);
    }
    this.groups.clear();
    return out;
  }
}

function box(scene: Scene, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): Mesh {
  const m = MeshBuilder.CreateBox("p", { width: w, height: h, depth: d }, scene);
  m.position.set(x, y, z);
  m.rotation.y = ry;
  return m;
}

function cyl(scene: Scene, dia: number, h: number, x: number, y: number, z: number, tess = 16): Mesh {
  const m = MeshBuilder.CreateCylinder("p", { diameter: dia, height: h, tessellation: tess }, scene);
  m.position.set(x, y, z);
  return m;
}

function sign(scene: Scene, lib: MaterialLibrary, name: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D, W: number, H: number) => void, emissive: number): PBRMaterial {
  const tex = lib.signTexture(`${name}_tex`, Math.round(512 * (w / Math.max(w, h))), Math.round(512 * (h / Math.max(w, h))), draw);
  const mat = new PBRMaterial(`${name}_mat`, scene);
  mat.albedoTexture = tex;
  mat.emissiveTexture = tex;
  mat.emissiveColor = new Color3(emissive, emissive, emissive);
  mat.roughness = 0.85;
  mat.metallic = 0;
  return mat;
}

export interface PropResult {
  /** Emissive meshes that may glow (neon, bulbs, panels). */
  glowing: Mesh[];
}

export function buildProps(scene: Scene, lib: MaterialLibrary): PropResult {
  const b = new Batch();
  const steel = lib.forBox("stainless");
  const dark = lib.solid("prop_dark", [0.08, 0.08, 0.09], 0.5, 0.3);
  const rubber = lib.solid("prop_rubber", [0.07, 0.07, 0.07], 0.95);
  const wood = lib.forBox("timber");
  const red = lib.solid("prop_red", [0.62, 0.06, 0.05], 0.45);
  const cream = lib.solid("prop_cream", [0.93, 0.89, 0.8], 0.6);
  const cardboard = lib.solid("prop_cardboard", [0.62, 0.45, 0.28], 0.9);
  const can = lib.solid("prop_can", [0.75, 0.76, 0.78], 0.3, 0.45);
  const canRed = lib.solid("prop_can_red", [0.7, 0.12, 0.08], 0.4);
  const white = lib.solid("prop_white", [0.92, 0.92, 0.9], 0.35);
  const glass = lib.solid("prop_glass", [0.55, 0.7, 0.75], 0.08);
  glass.alpha = 0.3;
  const panel = lib.solid("prop_panel", [1, 0.95, 0.85], 0.4, 0, [0.95, 0.88, 0.75]);
  const oil = lib.solid("prop_oil", [0.55, 0.38, 0.08], 0.05);
  const chrome = lib.solid("chrome", [0.85, 0.85, 0.87], 0.15, 1);
  const glowing: Mesh[] = [];

  // --- Cook line -----------------------------------------------------------------------------
  // Stainless backsplash along the north wall behind the line.
  b.add(steel, box(scene, 6.2, 0.8, 0.02, -1.0, 1.32, 4.985));
  // Hood filters and lamps.
  for (let i = 0; i < 4; i++) b.add(dark, box(scene, 0.44, 0.01, 0.6, -0.72 + i * 0.48, 2.145, 4.6));
  for (const x of [-0.6, 0.6]) {
    const lamp = box(scene, 0.3, 0.01, 0.12, x, 2.14, 4.3);
    b.add(panel, lamp);
  }
  // Shelf above the prep counter with stock.
  b.add(steel, box(scene, 2.9, 0.025, 0.28, -2.65, 1.78, 4.86));
  for (const x of [-3.95, -1.35]) b.add(steel, box(scene, 0.02, 0.2, 0.26, x, 1.68, 4.86));
  for (let i = 0; i < 7; i++) {
    const x = -3.9 + i * 0.16;
    b.add(i % 3 === 0 ? canRed : can, cyl(scene, 0.09, 0.13, x, 1.86, 4.86));
  }
  for (let i = 0; i < 3; i++) b.add(cardboard, box(scene, 0.32, 0.2, 0.24, -2.6 + i * 0.36, 1.89, 4.86));
  for (let i = 0; i < 6; i++) b.add(white, cyl(scene, 0.22, 0.012, -1.6, 1.8 + i * 0.014, 4.86, 24));
  // Utensil rail with hanging ladles and tongs.
  b.add(chrome, box(scene, 2.4, 0.015, 0.015, -2.6, 1.5, 4.95));
  for (let i = 0; i < 6; i++) {
    const x = -3.6 + i * 0.4;
    b.add(chrome, box(scene, 0.012, 0.22, 0.012, x, 1.38, 4.94));
    if (i % 2 === 0) b.add(chrome, cyl(scene, 0.07, 0.03, x, 1.27, 4.94));
    else b.add(dark, box(scene, 0.03, 0.08, 0.01, x, 1.25, 4.94));
  }
  // Grill front rail and fryer details.
  b.add(chrome, box(scene, 1.62, 0.02, 0.02, 0, 0.86, 4.12));
  b.add(oil, box(scene, 0.62, 0.005, 0.5, 1.5, 0.902, 4.6));
  for (const x of [1.36, 1.64]) {
    b.add(dark, box(scene, 0.22, 0.12, 0.3, x, 0.98, 4.55));
    b.add(dark, box(scene, 0.03, 0.03, 0.22, x, 1.05, 4.32));
  }
  // Anti-fatigue mats.
  b.add(rubber, box(scene, 1.8, 0.012, 0.8, 0, 0.006, 3.75));
  b.add(rubber, box(scene, 2.8, 0.012, 0.7, -2.6, 0.006, 3.85));
  b.add(rubber, box(scene, 2.2, 0.012, 0.6, -0.5, 0.006, 1.4));

  // Drinks machine and cups on the east counter.
  b.add(dark, box(scene, 0.7, 0.6, 0.38, 5.0, 1.3, 1.1));
  const drinksPanel = box(scene, 0.62, 0.22, 0.01, 5.0, 1.45, 0.905);
  b.add(sign(scene, lib, "drinks_panel", 0.62, 0.22, (ctx, W, H) => {
    const cols = ["#d92e2e", "#2e7bd9", "#f2c12e", "#3aa655"];
    cols.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect((i * W) / 4 + 4, 4, W / 4 - 8, H - 8);
    });
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.round(H * 0.3)}px system-ui`;
    ctx.textAlign = "center";
    ["COLA", "BLUE", "LEMON", "LIME"].forEach((t, i) => ctx.fillText(t, ((i + 0.5) * W) / 4, H * 0.62));
  }, 0.6), drinksPanel);
  glowing.push(drinksPanel);
  for (let i = 0; i < 4; i++) b.add(chrome, cyl(scene, 0.03, 0.06, 4.78 + i * 0.15, 1.02, 0.95));
  for (let i = 0; i < 3; i++) b.add(white, cyl(scene, 0.09, 0.28, 4.35, 1.14, 0.8 + i * 0.12, 20));

  // Sink basin and faucet.
  b.add(dark, box(scene, 0.6, 0.02, 0.9, -5.6, 0.915, 2.2));
  b.add(chrome, cyl(scene, 0.03, 0.3, -5.85, 1.07, 2.2));
  b.add(chrome, box(scene, 0.2, 0.025, 0.025, -5.76, 1.21, 2.2));
  // Walk-in door handle and window.
  b.add(chrome, box(scene, 0.04, 0.4, 0.05, -5.0, 1.1, 4.03));
  b.add(glass, box(scene, 0.3, 0.3, 0.01, -5.4, 1.5, 4.04));
  // Back office: chair, laptop and the recipe binder.
  b.add(dark, box(scene, 0.4, 0.04, 0.4, 5.1, 0.46, 3.65));
  b.add(dark, box(scene, 0.4, 0.45, 0.04, 5.1, 0.7, 3.45));
  b.add(dark, box(scene, 0.34, 0.015, 0.24, 5.0, 0.77, 4.3));
  b.add(red, box(scene, 0.24, 0.05, 0.32, 5.45, 0.785, 4.3));

  // --- Dining room ---------------------------------------------------------------------------
  // Baseboards and the diner stripe.
  for (const [w, d, x, z] of [
    [12.2, 0.03, 0, -5.985],
    [0.03, 5.9, -5.985, -3.0],
    [0.03, 5.9, 5.985, -3.0],
  ] as const) {
    b.add(dark, box(scene, w, 0.12, d, x, 0.06, z));
    b.add(red, box(scene, w, 0.08, d, x, 1.05, z));
    b.add(cream, box(scene, w, 0.03, d, x, 1.105, z));
  }
  // Booth backrest.
  b.add(red, box(scene, 0.2, 0.6, 2.4, -5.85, 0.8, -3.0));
  // Table condiments and napkin holders.
  for (const [x, z] of [
    [-3.5, -3.0],
    [0, -3.8],
    [3.5, -3.0],
  ] as const) {
    b.add(canRed, cyl(scene, 0.05, 0.16, x - 0.1, 0.82, z));
    b.add(lib.solid("prop_mustard", [0.92, 0.72, 0.08], 0.3), cyl(scene, 0.05, 0.16, x - 0.02, 0.82, z));
    b.add(chrome, box(scene, 0.12, 0.1, 0.06, x + 0.12, 0.79, z));
  }
  // Window mullions and door frame.
  for (const side of [-1, 1]) {
    for (let i = 0; i <= 4; i++) b.add(dark, box(scene, 0.05, 1.5, 0.08, side * (1.0 + i * 1.3), 1.65, -6.1));
    b.add(dark, box(scene, 5.2, 0.05, 0.08, side * 3.6, 0.92, -6.1));
  }
  b.add(dark, box(scene, 0.06, 2.5, 0.1, -1.0, 1.25, -6.1));
  b.add(dark, box(scene, 0.06, 2.5, 0.1, 1.0, 1.25, -6.1));
  b.add(chrome, box(scene, 0.03, 0.5, 0.04, 0.85, 1.1, -6.05));
  // Posters.
  const posterA = MeshBuilder.CreatePlane("poster_a", { width: 0.9, height: 1.2 }, scene);
  posterA.position.set(-5.975, 1.9, -1.8);
  posterA.rotation.y = -Math.PI / 2;
  b.add(sign(scene, lib, "poster_a", 0.9, 1.2, (ctx, W, H) => {
    ctx.fillStyle = "#1d2a33";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#f6b73c";
    ctx.font = `bold ${Math.round(W * 0.14)}px Georgia`;
    ctx.textAlign = "center";
    ctx.fillText("FRESH", W / 2, H * 0.22);
    ctx.fillText("BURGERS", W / 2, H * 0.36);
    ctx.fillStyle = "#c0392b";
    ctx.beginPath();
    ctx.ellipse(W / 2, H * 0.62, W * 0.32, H * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7a3b16";
    ctx.fillRect(W * 0.2, H * 0.6, W * 0.6, H * 0.05);
    ctx.fillStyle = "#f1ece2";
    ctx.font = `${Math.round(W * 0.07)}px Georgia`;
    ctx.fillText("SINCE 1987", W / 2, H * 0.88);
  }, 0.15), posterA);
  const posterB = MeshBuilder.CreatePlane("poster_b", { width: 0.9, height: 1.2 }, scene);
  posterB.position.set(5.975, 1.9, -1.8);
  posterB.rotation.y = Math.PI / 2;
  b.add(sign(scene, lib, "poster_b", 0.9, 1.2, (ctx, W, H) => {
    ctx.fillStyle = "#f1ece2";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#c0392b";
    ctx.font = `bold ${Math.round(W * 0.12)}px Georgia`;
    ctx.textAlign = "center";
    ctx.fillText("OPEN", W / 2, H * 0.3);
    ctx.fillText("LATE", W / 2, H * 0.45);
    ctx.fillStyle = "#1d2a33";
    ctx.font = `${Math.round(W * 0.06)}px Georgia`;
    ctx.fillText("the night shift", W / 2, H * 0.62);
    ctx.fillText("never sleeps", W / 2, H * 0.7);
  }, 0.15), posterB);
  // Neon BURGERS sign on the east dining wall.
  const neon = MeshBuilder.CreatePlane("neon_burgers", { width: 2.0, height: 0.5 }, scene);
  neon.position.set(5.97, 2.35, -3.4);
  neon.rotation.y = Math.PI / 2;
  const neonTex = lib.signTexture("neon_tex", 1024, 256, (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "#ffb347";
    ctx.lineWidth = 10;
    ctx.font = `bold ${Math.round(H * 0.62)}px Georgia`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeText("BURGERS", W / 2, H / 2);
    ctx.fillStyle = "#fff2cc";
    ctx.fillText("BURGERS", W / 2, H / 2);
  });
  neonTex.hasAlpha = true;
  const neonMat = new PBRMaterial("neon_mat", scene);
  neonMat.albedoTexture = neonTex;
  neonMat.useAlphaFromAlbedoTexture = true;
  neonMat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  neonMat.emissiveTexture = neonTex;
  neonMat.emissiveColor = new Color3(1.6, 1.0, 0.5);
  neonMat.disableLighting = true;
  neon.material = neonMat;
  neon.isPickable = false;
  glowing.push(neon);

  // Kitchen ceiling light panels.
  for (const [x, z] of [
    [-2.6, 3.6],
    [0.2, 3.6],
    [-0.5, 1.2],
  ] as const) {
    const p = box(scene, 1.0, 0.02, 0.35, x, 3.19, z);
    b.add(panel, p);
  }

  // --- Street --------------------------------------------------------------------------------
  b.add(lib.solid("prop_curb", [0.45, 0.45, 0.46], 0.9), box(scene, 30, 0.15, 0.25, 0, -0.08, -9.7));
  const dash = lib.solid("prop_dash", [0.9, 0.85, 0.6], 0.8, 0, [0.15, 0.13, 0.08]);
  for (let i = 0; i < 8; i++) b.add(dash, box(scene, 1.2, 0.01, 0.12, -13 + i * 3.6, -0.145, -13.5));
  const carBody = lib.solid("prop_car", [0.15, 0.32, 0.45], 0.25, 0.4);
  b.add(carBody, box(scene, 4.2, 0.7, 1.8, -4.5, 0.45, -11.2));
  b.add(carBody, box(scene, 2.2, 0.55, 1.6, -4.7, 1.05, -11.2));
  b.add(glass, box(scene, 2.25, 0.4, 1.62, -4.7, 1.08, -11.2));
  for (const [dx, dz] of [
    [-1.4, -0.85],
    [1.4, -0.85],
    [-1.4, 0.85],
    [1.4, 0.85],
  ] as const) {
    const w = MeshBuilder.CreateCylinder("wheel", { diameter: 0.62, height: 0.22, tessellation: 18 }, scene);
    w.rotation.x = Math.PI / 2;
    w.position.set(-4.5 + dx, 0.25, -11.2 + dz);
    b.add(rubber, w);
  }
  b.add(red, cyl(scene, 0.22, 0.6, 2.8, 0.2, -9.3));

  const merged = b.flush("props");
  const panelMesh = merged.find((m) => m.material === panel);
  if (panelMesh) glowing.push(panelMesh);
  return { glowing };
}
