import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { Material } from "@babylonjs/core/Materials/material";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";
import type { GraphicsPreset } from "../settings.js";

/**
 * Baked restaurant environment authored in Blender (assets/source/blender/restaurant.py):
 * static geometry with Cycles-baked irradiance lightmaps and AO on UV2, plus box-projected
 * reflection probes rendered from inside the room.
 *
 * Lightmaps are applied through Babylon's "shadows only" light mode: the one key light marked
 * LIGHTMAP_SHADOWSONLY adds `lightmap * shadow` to the diffuse term (so the baked irradiance is
 * multiplied by the full-resolution albedo, and dynamic objects still cast shadows onto baked
 * surfaces). The probe's diffuse irradiance is removed from those materials by a small plugin,
 * because the lightmap already contains all diffuse light; the probe only supplies reflections.
 */

const BASE = `${import.meta.env.BASE_URL}assets/restaurant/`;

interface Manifest {
  version: number;
  lightmaps: Record<string, { lightmap: string; ao: string; scale: number; size: number }>;
  probes: Record<string, { env: string; center: [number, number, number]; min: [number, number, number]; max: [number, number, number] }>;
}

export interface BakedEnvironment {
  /** Lightmapped meshes; only the key light may affect them. */
  staticMeshes: AbstractMesh[];
  /** Everything loaded (lightmapped and unbaked). */
  meshes: AbstractMesh[];
  /** Neon, bulbs and lamp lenses, for the glow layer. */
  glowMeshes: AbstractMesh[];
  /** Kitchen probe: used as the scene environment for dynamic objects. */
  kitchenProbe: CubeTexture;
}

/** Drops the probe's diffuse irradiance from materials whose diffuse light is baked. */
class BakedLightingPlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "BakedLighting", 200, { BAKEDLIGHTING: false }, true, true);
  }

  override isCompatible(language: ShaderLanguage): boolean {
    return language === ShaderLanguage.GLSL || language === ShaderLanguage.WGSL;
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines["BAKEDLIGHTING"] = true;
  }

  override getClassName(): string {
    return "BakedLightingPlugin";
  }

  override getCustomCode(shaderType: string, language?: ShaderLanguage): { [point: string]: string } | null {
    if (shaderType !== "fragment") return null;
    const zero = language === ShaderLanguage.WGSL ? "vec3f(0.0)" : "vec3(0.0)";
    return {
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
#if defined(BAKEDLIGHTING) && defined(REFLECTION)
finalIrradiance = ${zero};
#endif
`,
    };
  }
}

let loadersRegistered = false;

function groupOf(node: Node | null): string {
  for (let n: Node | null = node; n; n = n.parent) {
    const name = n.name;
    if (name.startsWith("unbaked_")) return name;
    if (name === "kitchen" || name === "dining" || name === "exterior") return name;
  }
  return "";
}

function probeTexture(scene: Scene, p: Manifest["probes"][string]): CubeTexture {
  const tex = CubeTexture.CreateFromPrefilteredData(`${BASE}${p.env}`, scene);
  tex.boundingBoxSize = new Vector3(p.max[0] - p.min[0], p.max[1] - p.min[1], p.max[2] - p.min[2]);
  tex.boundingBoxPosition = new Vector3((p.max[0] + p.min[0]) / 2, (p.max[1] + p.min[1]) / 2, (p.max[2] + p.min[2]) / 2);
  return tex;
}

function lightmapTexture(scene: Scene, file: string, level: number): Texture {
  const t = new Texture(`${BASE}${file}`, scene, { noMipmap: true, invertY: false, samplingMode: Texture.BILINEAR_SAMPLINGMODE });
  t.coordinatesIndex = 1;
  t.level = level;
  t.gammaSpace = true;
  t.wrapU = t.wrapV = Texture.CLAMP_ADDRESSMODE;
  return t;
}

export async function loadBakedEnvironment(scene: Scene, preset: GraphicsPreset): Promise<BakedEnvironment> {
  const res = await fetch(`${BASE}restaurant.json`);
  if (!res.ok) throw new Error(`restaurant.json: ${res.status}`);
  const manifest = (await res.json()) as Manifest;
  if (!loadersRegistered) {
    registerBuiltInLoaders();
    loadersRegistered = true;
  }
  const container = await LoadAssetContainerAsync("restaurant.gltf", scene, { rootUrl: BASE });

  const probes: Record<string, CubeTexture> = {};
  for (const [name, p] of Object.entries(manifest.probes)) probes[name] = probeTexture(scene, p);
  const kitchenProbe = probes["kitchen"]!;
  const diningProbe = probes["dining"] ?? kitchenProbe;
  const lightmaps: Record<string, { lm: Texture; ao: Texture }> = {};
  for (const [name, l] of Object.entries(manifest.lightmaps)) {
    const ao = new Texture(`${BASE}${l.ao}`, scene, { noMipmap: true, invertY: false });
    ao.coordinatesIndex = 1;
    ao.gammaSpace = false;
    lightmaps[name] = { lm: lightmapTexture(scene, l.lightmap, l.scale), ao };
  }

  const variants = new Map<string, PBRMaterial>();
  const variant = (mat: PBRMaterial, group: string): PBRMaterial => {
    const key = `${mat.name}|${group}`;
    let v = variants.get(key);
    if (v) return v;
    v = mat.clone(`${mat.name}__${group}`) as PBRMaterial;
    const region = group.replace("unbaked_", "");
    v.reflectionTexture = region === "kitchen" ? kitchenProbe : diningProbe;
    const lm = lightmaps[group];
    if (lm) {
      v.lightmapTexture = lm.lm;
      v.useLightmapAsShadowmap = false;
      v.ambientTexture = lm.ao;
      v.useAmbientInGrayScale = true;
      v.useRadianceOcclusion = true;
      new BakedLightingPlugin(v);
    }
    v.maxSimultaneousLights = 4;
    variants.set(key, v);
    return v;
  };

  const staticMeshes: AbstractMesh[] = [];
  const glowMeshes: AbstractMesh[] = [];
  const meshes: AbstractMesh[] = [];
  container.addAllToScene();
  for (const mesh of container.meshes) {
    if (!(mesh instanceof Mesh) || mesh.getTotalVertices() === 0) continue;
    const group = groupOf(mesh);
    const mat = mesh.material as PBRMaterial | null;
    mesh.isPickable = false;
    mesh.metadata = { ...(mesh.metadata ?? {}), baked: group };
    meshes.push(mesh);
    if (!mat || !group) continue;
    const name = mat.name;
    if (name === "glass") {
      const g = mat;
      g.albedoColor = new Color3(0.02, 0.025, 0.03);
      g.alpha = 0.14;
      g.metallic = 0;
      g.roughness = 0.04;
      g.reflectionTexture = group.endsWith("kitchen") ? kitchenProbe : diningProbe;
      g.environmentIntensity = 1.0;
      g.backFaceCulling = false;
      g.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      continue;
    }
    if (name.startsWith("emit_") || name.startsWith("screen_") || name.startsWith("store_") || name.startsWith("apt_") || name === "fountain_panel") {
      // Light sources and screens: emission only, no lighting work.
      mat.unlit = name.startsWith("emit_");
      if (name.startsWith("emit_neon") || name.startsWith("emit_bulb") || name === "emit_heat_element" || name === "emit_sodium") glowMeshes.push(mesh);
      continue;
    }
    mesh.material = variant(mat, group);
    if (lightmaps[group]) {
      mesh.receiveShadows = preset !== "low";
      staticMeshes.push(mesh);
    }
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
  }
  scene.environmentTexture = kitchenProbe;
  return { staticMeshes, meshes, glowMeshes, kitchenProbe };
}
