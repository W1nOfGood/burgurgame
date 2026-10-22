import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { Scene } from "@babylonjs/core/scene";
import { PLAYER } from "@ahb/data";
import type { MaterialLibrary } from "./materials.js";
import { setPick } from "./scene.js";

export const PLAYER_COLORS: [number, number, number][] = [
  [0.85, 0.25, 0.2],
  [0.2, 0.5, 0.85],
  [0.95, 0.7, 0.15],
  [0.3, 0.7, 0.35],
  [0.65, 0.35, 0.8],
  [0.95, 0.45, 0.65],
];

/** Teammate presentation: body, head that follows pitch, hands, cap colour and a name tag. */
export class AvatarView {
  readonly id: string;
  readonly root: TransformNode;
  private readonly head: Mesh;
  private readonly body: Mesh;
  private readonly handR: Mesh;
  private readonly handL: Mesh;
  private readonly tag: Mesh;
  private readonly tagTex: DynamicTexture;
  private tagKey = "";
  private readonly meshes: Mesh[] = [];

  constructor(scene: Scene, lib: MaterialLibrary, id: string, color: number) {
    this.id = id;
    this.root = new TransformNode(`avatar_${id}`, scene);
    const c = PLAYER_COLORS[color % PLAYER_COLORS.length]!;
    const shirt = lib.solid(`shirt_${color}`, c, 0.7);
    const skin = lib.solid("skin", [0.86, 0.66, 0.52], 0.55);
    const apron = lib.solid("apron", [0.92, 0.9, 0.86], 0.85);

    const height = (PLAYER.halfHeight + PLAYER.radius) * 2;
    this.body = MeshBuilder.CreateCapsule(`avatar_body_${id}`, { radius: 0.24, height: height - 0.3, tessellation: 12 }, scene);
    this.body.position.y = (height - 0.3) / 2;
    this.body.material = shirt;
    this.body.parent = this.root;
    const ap = MeshBuilder.CreatePlane(`avatar_apron_${id}`, { width: 0.36, height: 0.7 }, scene);
    ap.position.set(0, 0.75, 0.245);
    ap.rotation.y = Math.PI;
    ap.material = apron;
    ap.parent = this.root;

    this.head = MeshBuilder.CreateSphere(`avatar_head_${id}`, { diameter: 0.26, segments: 12 }, scene);
    this.head.position.y = PLAYER.eyeHeight - 0.02;
    this.head.material = skin;
    this.head.parent = this.root;
    this.head.rotationQuaternion = Quaternion.Identity();
    const cap = MeshBuilder.CreateCylinder(`avatar_cap_${id}`, { diameterTop: 0.22, diameterBottom: 0.27, height: 0.09, tessellation: 16 }, scene);
    cap.position.y = 0.1;
    cap.material = shirt;
    cap.parent = this.head;
    const brim = MeshBuilder.CreateBox(`avatar_brim_${id}`, { width: 0.2, height: 0.012, depth: 0.12 }, scene);
    brim.position.set(0, 0.07, 0.15);
    brim.material = shirt;
    brim.parent = this.head;
    const eyeMat = lib.solid("eye", [0.05, 0.05, 0.05], 0.2);
    for (const dx of [-0.045, 0.045]) {
      const eye = MeshBuilder.CreateSphere(`avatar_eye_${id}_${dx}`, { diameter: 0.03, segments: 6 }, scene);
      eye.position.set(dx, 0.02, 0.118);
      eye.material = eyeMat;
      eye.parent = this.head;
      this.meshes.push(eye);
    }
    this.handR = MeshBuilder.CreateSphere(`avatar_hr_${id}`, { diameter: 0.09, segments: 8 }, scene);
    this.handL = MeshBuilder.CreateSphere(`avatar_hl_${id}`, { diameter: 0.09, segments: 8 }, scene);
    for (const h of [this.handR, this.handL]) {
      h.material = skin;
      h.parent = this.root;
    }
    this.handR.position.set(0.28, 1.0, 0.12);
    this.handL.position.set(-0.28, 1.0, 0.12);

    this.tagTex = new DynamicTexture(`tag_${id}`, { width: 256, height: 64 }, scene, true);
    this.tagTex.hasAlpha = true;
    const tagMat = new PBRMaterial(`tag_mat_${id}`, scene);
    tagMat.albedoTexture = this.tagTex;
    tagMat.emissiveTexture = this.tagTex;
    tagMat.emissiveColor = new Color3(1, 1, 1);
    tagMat.useAlphaFromAlbedoTexture = true;
    tagMat.disableLighting = true;
    tagMat.backFaceCulling = false;
    this.tag = MeshBuilder.CreatePlane(`avatar_tag_${id}`, { width: 0.6, height: 0.15 }, scene);
    this.tag.material = tagMat;
    this.tag.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.tag.position.y = PLAYER.eyeHeight + 0.32;
    this.tag.parent = this.root;
    this.tag.isPickable = false;

    this.meshes.push(this.body, ap, this.head, cap, brim, this.handR, this.handL);
    for (const m of this.meshes) setPick(m, { type: "player", id });
  }

  get castMeshes(): Mesh[] {
    return [this.body, this.head, this.handR, this.handL];
  }

  update(x: number, y: number, z: number, yaw: number, pitch: number, crouch: boolean, holding: boolean, label: string, faded: boolean): void {
    this.root.position.set(x, y - (crouch ? 0.4 : 0), z);
    this.root.rotation.y = yaw;
    Quaternion.RotationYawPitchRollToRef(0, pitch * 0.7, 0, this.head.rotationQuaternion!);
    const reach = holding ? 0.38 : 0.12;
    const handY = holding ? 1.25 - pitch * 0.3 : 1.0;
    this.handR.position.set(holding ? 0.14 : 0.28, handY, reach);
    this.handL.position.set(holding ? -0.14 : -0.28, handY, reach);
    const vis = faded ? 0.35 : 1;
    for (const m of this.meshes) m.visibility = vis;
    if (label !== this.tagKey) {
      this.tagKey = label;
      const ctx = this.tagTex.getContext() as unknown as CanvasRenderingContext2D;
      ctx.clearRect(0, 0, 256, 64);
      ctx.fillStyle = "rgba(15,12,10,0.7)";
      ctx.beginPath();
      ctx.roundRect(4, 8, 248, 48, 14);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 28px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label.slice(0, 18), 128, 33);
      this.tagTex.update(true);
    }
  }

  dispose(): void {
    this.root.dispose(false, true);
  }
}
