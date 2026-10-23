import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { Scene } from "@babylonjs/core/scene";
import { PLAYER } from "@ahb/data";
import type { MaterialLibrary } from "./materials.js";
import { setPick } from "./scene.js";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { BoneDriver, findNode, loadContainer, mountGltfNode } from "./rig.js";

let crewContainer: AssetContainer | null = null;

/** Loads the rigged crew member (characters.py); avatars upgrade from their stand-ins. */
export async function loadCrew(scene: Scene): Promise<void> {
  crewContainer = await loadContainer(scene, "crew.gltf");
}

interface CrewRig {
  holder: TransformNode;
  meshes: AbstractMesh[];
  d: Record<string, BoneDriver>;
}

export const PLAYER_COLORS: [number, number, number][] = [
  [0.85, 0.25, 0.2],
  [0.2, 0.5, 0.85],
  [0.95, 0.7, 0.15],
  [0.3, 0.7, 0.35],
  [0.65, 0.35, 0.8],
  [0.95, 0.45, 0.65],
];

const SKIN_TONES: [number, number, number][] = [
  [0.92, 0.72, 0.58],
  [0.78, 0.56, 0.42],
  [0.55, 0.37, 0.26],
  [0.98, 0.8, 0.67],
];

/**
 * Teammate presentation: a simple jointed body with a walk cycle, arms that reach for held
 * items, a head that follows look pitch, the player's colour on hat and shirt, and a name tag.
 * Placeholder until rigged characters arrive in Stage 3.
 */
export class AvatarView {
  readonly id: string;
  readonly root: TransformNode;
  private readonly body: TransformNode;
  private readonly head: Mesh;
  private readonly legL: TransformNode;
  private readonly legR: TransformNode;
  private readonly armL: TransformNode;
  private readonly armR: TransformNode;
  private readonly tag: Mesh;
  private readonly tagTex: DynamicTexture;
  private tagKey = "";
  private readonly meshes: Mesh[] = [];
  private readonly casters: Mesh[] = [];
  private phase = 0;
  private last = { x: 0, z: 0, t: 0 };
  private speed = 0;
  private rig: CrewRig | null = null;
  private readonly owned: PBRMaterial[] = [];
  private readonly color: number;
  private readonly scene: Scene;

  constructor(scene: Scene, lib: MaterialLibrary, id: string, color: number) {
    this.id = id;
    this.color = color;
    this.scene = scene;
    const seed = [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
    this.root = new TransformNode(`avatar_${id}`, scene);
    this.body = new TransformNode(`avatar_body_${id}`, scene);
    this.body.parent = this.root;
    const c = PLAYER_COLORS[color % PLAYER_COLORS.length]!;
    const shirt = lib.solid(`shirt_${color}`, c, 0.75);
    const skinTone = SKIN_TONES[seed % SKIN_TONES.length]!;
    const skin = lib.solid(`skin_${seed % SKIN_TONES.length}`, skinTone, 0.55);
    const apron = lib.solid("apron", [0.94, 0.92, 0.88], 0.85);
    const trousers = lib.solid("trousers", [0.12, 0.13, 0.17], 0.8);
    const shoe = lib.solid("shoe", [0.05, 0.05, 0.05], 0.5);
    const paper = lib.solid("paper_hat", [0.97, 0.97, 0.95], 0.8);
    const eyeWhite = lib.solid("eye_white", [0.96, 0.96, 0.96], 0.3);
    const pupil = lib.solid("pupil", [0.06, 0.05, 0.05], 0.2);
    const lip = lib.solid("lip", [skinTone[0] * 0.7, skinTone[1] * 0.45, skinTone[2] * 0.45], 0.5);
    const add = (m: Mesh, parent: TransformNode, cast = false) => {
      m.parent = parent;
      this.meshes.push(m);
      if (cast) this.casters.push(m);
      return m;
    };

    // Legs pivot at the hips.
    const mkLeg = (side: number) => {
      const pivot = new TransformNode(`avatar_leg_${id}_${side}`, scene);
      pivot.parent = this.body;
      pivot.position.set(side * 0.1, 0.86, 0);
      const leg = add(MeshBuilder.CreateCapsule(`avatar_legm_${id}_${side}`, { radius: 0.075, height: 0.84, tessellation: 10 }, scene), pivot, true);
      leg.position.y = -0.42;
      leg.material = trousers;
      const foot = add(MeshBuilder.CreateBox(`avatar_foot_${id}_${side}`, { width: 0.11, height: 0.07, depth: 0.24 }, scene), pivot);
      foot.position.set(0, -0.84, 0.05);
      foot.material = shoe;
      return pivot;
    };
    this.legL = mkLeg(-1);
    this.legR = mkLeg(1);

    const torso = add(MeshBuilder.CreateCapsule(`avatar_torso_${id}`, { radius: 0.2, height: 0.72, tessellation: 14 }, scene), this.body, true);
    torso.position.y = 1.18;
    torso.scaling.z = 0.75;
    torso.material = shirt;
    const ap = add(MeshBuilder.CreatePlane(`avatar_apron_${id}`, { width: 0.34, height: 0.66 }, scene), this.body);
    ap.position.set(0, 1.02, 0.152);
    ap.rotation.y = Math.PI;
    ap.material = apron;
    const strap = add(MeshBuilder.CreateBox(`avatar_strap_${id}`, { width: 0.42, height: 0.03, depth: 0.31 }, scene), this.body);
    strap.position.set(0, 1.12, 0);
    strap.material = apron;

    const mkArm = (side: number) => {
      const pivot = new TransformNode(`avatar_arm_${id}_${side}`, scene);
      pivot.parent = this.body;
      pivot.position.set(side * 0.25, 1.42, 0);
      const arm = add(MeshBuilder.CreateCapsule(`avatar_armm_${id}_${side}`, { radius: 0.06, height: 0.6, tessellation: 10 }, scene), pivot, true);
      arm.position.y = -0.28;
      arm.material = shirt;
      const hand = add(MeshBuilder.CreateSphere(`avatar_hand_${id}_${side}`, { diameter: 0.1, segments: 10 }, scene), pivot);
      hand.position.y = -0.6;
      hand.scaling.set(0.85, 1, 0.75);
      hand.material = skin;
      return pivot;
    };
    this.armL = mkArm(-1);
    this.armR = mkArm(1);

    const neck = add(MeshBuilder.CreateCylinder(`avatar_neck_${id}`, { diameter: 0.1, height: 0.1, tessellation: 10 }, scene), this.body);
    neck.position.y = 1.56;
    neck.material = skin;
    this.head = add(MeshBuilder.CreateSphere(`avatar_head_${id}`, { diameter: 0.24, segments: 16 }, scene), this.body, true);
    this.head.position.y = PLAYER.eyeHeight - 0.02;
    this.head.scaling.set(0.92, 1.05, 0.98);
    this.head.material = skin;
    this.head.rotationQuaternion = Quaternion.Identity();
    // Diner paper hat with a band in the player's colour.
    const hat = add(MeshBuilder.CreateBox(`avatar_hat_${id}`, { width: 0.2, height: 0.08, depth: 0.26 }, scene), this.head as unknown as TransformNode);
    hat.position.set(0, 0.12, -0.005);
    hat.material = paper;
    const band = add(MeshBuilder.CreateBox(`avatar_band_${id}`, { width: 0.205, height: 0.025, depth: 0.265 }, scene), this.head as unknown as TransformNode);
    band.position.set(0, 0.09, -0.005);
    band.material = shirt;
    for (const dx of [-0.042, 0.042]) {
      const w = add(MeshBuilder.CreateSphere(`avatar_eyew_${id}_${dx}`, { diameter: 0.04, segments: 8 }, scene), this.head as unknown as TransformNode);
      w.position.set(dx, 0.02, 0.1);
      w.scaling.z = 0.5;
      w.material = eyeWhite;
      const p = add(MeshBuilder.CreateSphere(`avatar_eyep_${id}_${dx}`, { diameter: 0.02, segments: 6 }, scene), this.head as unknown as TransformNode);
      p.position.set(dx, 0.02, 0.11);
      p.material = pupil;
    }
    const nose = add(MeshBuilder.CreateSphere(`avatar_nose_${id}`, { diameter: 0.035, segments: 6 }, scene), this.head as unknown as TransformNode);
    nose.position.set(0, -0.01, 0.115);
    nose.material = skin;
    const mouth = add(MeshBuilder.CreateBox(`avatar_mouth_${id}`, { width: 0.05, height: 0.008, depth: 0.01 }, scene), this.head as unknown as TransformNode);
    mouth.position.set(0, -0.05, 0.105);
    mouth.material = lip;

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
    this.tag.position.y = PLAYER.eyeHeight + 0.36;
    this.tag.parent = this.root;
    this.tag.isPickable = false;

    for (const m of this.meshes) setPick(m, { type: "player", id });
    this.upgrade();
  }

  get castMeshes(): Mesh[] {
    return this.rig ? (this.rig.meshes as Mesh[]) : this.casters;
  }

  /** Replaces the stand-in body with the rigged crew member once it has loaded. */
  upgrade(): boolean {
    if (this.rig || !crewContainer) return false;
    const scene = this.scene;
    const inst = crewContainer.instantiateModelsToScene((n) => `${n}_${this.id}`, false, { doNotInstantiate: true });
    const gltfRoot = inst.rootNodes[0];
    const armature = gltfRoot?.getChildren().find((n) => n.name.startsWith("crew_"));
    if (!gltfRoot || !armature) return false;
    // Calibrate with the avatar at the origin facing +Z, then restore its pose.
    const pos = this.root.position.clone();
    const yaw = this.root.rotation.y;
    this.root.position.setAll(0);
    this.root.rotation.y = 0;
    const holder = new TransformNode(`crew_holder_${this.id}`, scene);
    holder.parent = this.root;
    mountGltfNode(armature, holder, scene);
    gltfRoot.dispose(true, false);
    for (const n of [holder, ...holder.getDescendants(false)]) (n as TransformNode).computeWorldMatrix?.(true);
    const right = new Vector3(1, 0, 0);
    const fwd = new Vector3(0, 0, 1);
    const back = new Vector3(0, 0, -1);
    const node = (n: string) => findNode(armature, `${n}_${this.id}`) ?? findNode(armature, n);
    const d: Record<string, BoneDriver> = {};
    const drive = (bone: string, child: string | null, axis: Vector3, towards: Vector3) => {
      const b = node(bone);
      if (b) d[bone] = new BoneDriver(b, axis, child ? node(child) : null, towards);
    };
    for (const t of ["l", "r"]) {
      drive(`thigh_${t}`, `shin_${t}`, right, fwd);
      drive(`shin_${t}`, `foot_${t}`, right, back);
      drive(`upperarm_${t}`, `forearm_${t}`, right, fwd);
      drive(`forearm_${t}`, `hand_${t}`, right, fwd);
    }
    drive("spine", "chest", right, fwd);
    drive("neck", "head", right, fwd);
    drive("head", null, right, fwd);
    const meshes = holder.getChildMeshes(false);
    const c = PLAYER_COLORS[this.color % PLAYER_COLORS.length]!;
    for (const m of meshes) {
      setPick(m as Mesh, { type: "player", id: this.id });
      const mat = m.material as PBRMaterial | null;
      if (mat && mat.name.startsWith("crew_cap")) {
        const tinted = mat.clone(`crew_cap_${this.id}`) as PBRMaterial;
        tinted.albedoColor = new Color3(c[0], c[1], c[2]).toLinearSpace();
        m.material = tinted;
        this.owned.push(tinted);
      }
    }
    for (const m of this.meshes) m.setEnabled(false);
    this.root.position.copyFrom(pos);
    this.root.rotation.y = yaw;
    this.rig = { holder, meshes, d };
    return true;
  }

  update(x: number, y: number, z: number, yaw: number, pitch: number, crouch: boolean, holding: boolean, label: string, faded: boolean): void {
    const now = performance.now();
    const dt = this.last.t ? Math.min(0.1, (now - this.last.t) / 1000) : 0;
    if (dt > 0) {
      const v = Math.hypot(x - this.last.x, z - this.last.z) / dt;
      this.speed += (v - this.speed) * Math.min(1, dt * 10);
    }
    this.last = { x, z, t: now };
    this.root.position.set(x, y, z);
    this.root.rotation.y = yaw;
    // Walk cycle scaled by speed; crouching folds the body down.
    this.phase += dt * this.speed * 5.5;
    const swing = Math.sin(this.phase) * Math.min(0.6, this.speed * 0.28);
    if (this.rig) {
      const r = this.rig.d;
      const amt = Math.min(1, this.speed * 0.5);
      const crouchK = crouch ? 1 : 0;
      r["thigh_l"]?.set(swing * 0.9 + crouchK * 1.25);
      r["thigh_r"]?.set(-swing * 0.9 + crouchK * 1.25);
      r["shin_l"]?.set(Math.max(0, -Math.sin(this.phase - 0.6)) * 0.9 * amt + crouchK * 1.7);
      r["shin_r"]?.set(Math.max(0, Math.sin(this.phase - 0.6)) * 0.9 * amt + crouchK * 1.7);
      const reach = holding ? 1.05 - pitch * 0.45 : 0;
      r["upperarm_l"]?.set(holding ? reach : -swing * 0.75);
      r["upperarm_r"]?.set(holding ? reach : swing * 0.75);
      r["forearm_l"]?.set(holding ? 0.55 : 0.12 + Math.max(0, -swing) * 0.3);
      r["forearm_r"]?.set(holding ? 0.55 : 0.12 + Math.max(0, swing) * 0.3);
      r["spine"]?.set(crouchK * 0.35 + amt * 0.05);
      r["neck"]?.set(pitch * 0.35);
      r["head"]?.set(pitch * 0.45);
      this.rig.holder.position.y = crouch ? -0.38 : Math.abs(Math.cos(this.phase)) * Math.min(0.025, this.speed * 0.01);
      const vis = faded ? 0.35 : 1;
      for (const m of this.rig.meshes) m.visibility = vis;
    }
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.body.position.y = crouch ? -0.38 : Math.abs(Math.cos(this.phase)) * Math.min(0.03, this.speed * 0.012);
    const reach = holding ? -1.25 + pitch * 0.5 : 0;
    this.armL.rotation.x = holding ? reach : -swing * 0.8;
    this.armR.rotation.x = holding ? reach : swing * 0.8;
    this.armL.rotation.z = holding ? -0.25 : 0.05;
    this.armR.rotation.z = holding ? 0.25 : -0.05;
    Quaternion.RotationYawPitchRollToRef(0, pitch * 0.7, 0, this.head.rotationQuaternion!);
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
    // Body materials are shared between avatars (library + glTF), so only this avatar's own
    // tag and tinted cap are released.
    this.root.dispose(false, false);
    this.tag.material?.dispose(false, false);
    this.tagTex.dispose();
    for (const m of this.owned) m.dispose(false, false);
  }
}
