import { Engine } from "@babylonjs/core/Engines/engine";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import "@babylonjs/core/Culling/ray";
import "@babylonjs/core/Rendering/outlineRenderer";
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import { SSAO2RenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline";
import "@babylonjs/core/Rendering/geometryBufferRendererSceneComponent";
import "@babylonjs/core/Rendering/prePassRendererSceneComponent";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent";
import {
  DISPENSERS,
  FRONT_DOOR,
  GRILL_ZONES,
  INTERACTION,
  ITEMS,
  MODIFIERS,
  NET,
  PLAYER,
  RECIPES,
  isPatty,
  isSauceBottle,
  type ItemKind,
  type ModifierId,
  type RecipeId,
} from "@ahb/data";
import {
  BUTTON_CROUCH,
  BUTTON_SPRINT,
  FixedStepper,
  canAddToStack,
  customerPose,
  inTrashZone,
  isNoPlaceArea,
  lookDirection,
  restingHeight,
  sizzleLevel,
  stackOffsets,
  surfaceAt,
  wrapAngle,
  type CustomerPhase,
  type Rapier,
} from "@ahb/simulation";
import { MSG, PING_TEXT, readFoodBytes, type ItemState, type PingPreset, type ResultMessage } from "@ahb/protocol";
import type { Session } from "../net/session.js";
import { ServerClock, SnapshotBuffer, type Pose } from "../net/interp.js";
import { isTouchDevice, saveSettings, type Settings } from "../settings.js";
import type { Ui } from "../ui/ui.js";
import { AudioEngine, type Sfx } from "./audio.js";
import { FirstPersonHands } from "./hands.js";
import { InputManager, type Action } from "./input.js";
import { ItemView, describeFood, setFoodLibrary } from "./items.js";
import { FoodLibrary } from "./food.js";
import { GrillSmoke, type SmokeSource } from "./smoke.js";
import { AvatarView, loadCrew } from "./players.js";
import { CustomerView, loadCustomers } from "./customers.js";
import { LocalPlayer } from "./prediction.js";
import { RestaurantView, getPick, type PickInfo } from "./scene.js";
import { TouchControls } from "./touchControls.js";

export interface GameHooks {
  openMenu(): void;
  openPing(): void;
  openRecipes(): void;
  leave(reason: string, code: number): void;
}

interface Target {
  pick: PickInfo;
  point: Vector3;
  normal: Vector3 | null;
  mesh: AbstractMesh;
}

type Capture =
  | { type: "knob"; zone: number; value: number }
  | { type: "drawer"; value: number }
  | { type: "squeeze"; target: string }
  | null;

/** Short build reminder used only when the player turns on recipe hints. */
export function recipeHint(id: RecipeId): string {
  const r = RECIPES[id];
  const names: Partial<Record<ItemKind, string>> = { veggie_patty: "veggie", bun_bottom: "", bun_top: "", jalapeno: "jalapeño" };
  const layers = r.layers.map((k) => (k in names ? names[k] : k) as string).filter(Boolean);
  const grilled = (r.grilled ?? []).map((g) => `grilled ${g}`);
  return `${layers.join(" · ")}${grilled.length ? ` (${grilled.join(", ")})` : ""} | ${r.sauces.join(" + ")}`;
}

const TMP_POSE: Pose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };

/** Creates the WebGL2 engine (required baseline); WebGPU only after capability checks. */
export async function createEngine(canvas: HTMLCanvasElement, settings: Settings): Promise<AbstractEngine> {
  if (settings.preferWebGPU && "gpu" in navigator) {
    try {
      const { WebGPUEngine } = await import("@babylonjs/core/Engines/webgpuEngine");
      if (await WebGPUEngine.IsSupportedAsync) {
        const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: false });
        await engine.initAsync();
        return engine;
      }
    } catch (err) {
      console.warn("WebGPU initialisation failed; recreating with WebGL2", err);
    }
  }
  const engine = new Engine(canvas, settings.graphics !== "low", { stencil: true, powerPreference: "high-performance", disableWebGL2Support: false, failIfMajorPerformanceCaveat: false }, false);
  if (engine.webGLVersion < 2) {
    engine.dispose();
    throw new Error("This game needs WebGL2. Update your browser or enable hardware acceleration.");
  }
  return engine;
}

export class Game {
  readonly engine: AbstractEngine;
  readonly scene: Scene;
  readonly camera: FreeCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly session: Session;
  private readonly ui: Ui;
  private readonly hooks: GameHooks;
  private settings: Settings;
  private readonly restaurant: RestaurantView;
  private readonly items = new Map<string, ItemView>();
  private readonly itemBuffers = new Map<string, SnapshotBuffer>();
  private readonly avatars = new Map<string, AvatarView>();
  private readonly avatarBuffers = new Map<string, SnapshotBuffer>();
  private readonly customers = new Map<string, CustomerView>();
  /** Render tick at which customers froze for a pause (the server shifts their clocks on resume). */
  private customerFreeze: number | null = null;
  private doorOpen = 0;
  private readonly local: LocalPlayer;
  readonly input: InputManager;
  private readonly touch: TouchControls | null;
  private readonly hands: FirstPersonHands;
  readonly audio: AudioEngine;
  private readonly clock = new ServerClock(NET.tickHz, NET.interpolationDelayMs);
  private readonly stepper = new FixedStepper(NET.tickHz, NET.maxCatchUpSteps);
  private yaw = 0;
  private pitch = 0.15;
  private hold: number = INTERACTION.holdDistanceDefault;
  private rotYaw = 0;
  private rotPitch = 0;
  private crouchBlend = 0;
  private sendAccumulator = 0;
  private target: Target | null = null;
  private capture: Capture = null;
  private controlSendTimer = 0;
  private knobOverride = new Map<number, { value: number; until: number }>();
  private drawerOverride: { value: number; until: number } | null = null;
  private heldOverride: { id: string | null; kind: ItemKind | null; until: number } | null = null;
  private placeOverride = new Map<string, { x: number; y: number; z: number; until: number }>();
  private spawnGhost: ItemView | null = null;
  private previewGhost: ItemView | null = null;
  private pressBeganHolding = false;
  private inspecting = false;
  private ticketsVisible: boolean;
  private snapped = false;
  private moving = 0;
  private menuOpen = false;
  private lastHeldServer = "";
  private orderCount = 0;
  private markers: { mesh: Mesh; until: number }[] = [];
  private disposed = false;
  private readonly smoke: GrillSmoke | null;
  /** Resolves once the authored restaurant, food and crew have loaded (or fallen back). */
  readonly ready: Promise<void>;
  private instrumentation: SceneInstrumentation | null = null;

  constructor(engine: AbstractEngine, canvas: HTMLCanvasElement, session: Session, ui: Ui, settings: Settings, R: Rapier, audio: AudioEngine, hooks: GameHooks) {
    this.engine = engine;
    this.canvas = canvas;
    this.session = session;
    this.ui = ui;
    this.settings = settings;
    this.audio = audio;
    this.hooks = hooks;
    this.ticketsVisible = settings.showTicketOverlay;
    this.applyRenderScale();

    const scene = new Scene(engine);
    this.scene = scene;
    scene.clearColor = new Color4(0.03, 0.03, 0.05, 1);
    scene.ambientColor = new Color3(0.08, 0.06, 0.05);
    scene.skipPointerMovePicking = true;
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    scene.imageProcessingConfiguration.exposure = 1.25;
    scene.imageProcessingConfiguration.contrast = 1.1;

    this.camera = new FreeCamera("eye", new Vector3(0, PLAYER.eyeHeight, 3), scene);
    this.camera.inputs.clear();
    this.camera.minZ = 0.03;
    this.camera.maxZ = 80;
    this.camera.fov = (settings.fov * Math.PI) / 180;

    this.restaurant = new RestaurantView(scene, settings.graphics);
    this.hands = new FirstPersonHands(scene, this.camera, this.restaurant.materials, settings.graphics);
    this.setupPostProcessing(settings);
    this.smoke = settings.graphics === "low" ? null : new GrillSmoke(scene, settings.graphics);
    const envReady = this.restaurant.load();
    const foodReady = FoodLibrary.load(scene)
      .then((lib) => {
        if (this.disposed) return;
        setFoodLibrary(lib);
        for (const view of this.items.values()) if (view.upgrade()) this.restaurant.registerCasters(view.meshes());
      })
      .catch((err) => console.warn("Authored food unavailable; keeping procedural items", err));
    const crewReady = loadCrew(scene)
      .then(() => {
        if (this.disposed) return;
        for (const av of this.avatars.values()) if (av.upgrade()) this.restaurant.registerCasters(av.castMeshes);
      })
      .catch((err) => console.warn("Rigged crew unavailable; keeping stand-in avatars", err));
    const customersReady = loadCustomers(scene)
      .then(() => {
        if (this.disposed) return;
        for (const c of this.customers.values()) if (c.upgrade()) this.restaurant.registerCasters(c.castMeshes as Mesh[]);
      })
      .catch((err) => console.warn("Customer models unavailable; keeping stand-ins", err));
    this.ready = Promise.allSettled([envReady, foodReady, crewReady, customersReady]).then(() => undefined);

    const me = session.state.players.get(session.sessionId);
    this.local = new LocalPlayer(R, { x: me?.x ?? 0, y: me?.y ?? 0, z: me?.z ?? 3 });
    this.yaw = me?.yaw ?? 0;

    this.input = new InputManager(canvas, settings, {
      primaryDown: (x, y, kind) => this.primaryDown(x, y, kind),
      primaryUp: (x, y, kind, captured, moved) => this.primaryUp(x, y, kind, captured, moved),
      captureMove: (dx, dy) => this.captureMove(dx, dy),
      action: (a) => this.onAction(a),
      actionEnd: (a) => {
        if (a === "inspect") this.inspecting = false;
      },
    });
    this.touch = isTouchDevice()
      ? new TouchControls(ui.root, this.input, settings, (a, down) => {
          if (!down) {
            if (a === "inspect") this.inspecting = false;
            return;
          }
          if (a === "menu") this.hooks.openMenu();
          else if (a === "closer") this.hold = InputManager.clampHold(this.hold - 0.12);
          else if (a === "farther") this.hold = InputManager.clampHold(this.hold + 0.12);
          else if (a !== "rotate") this.onAction(a as Action);
        })
      : null;
    if (this.touch) this.input.lastPointer = "touch";

    session.room.onStateChange(() => this.onState());
    session.on("toast", (t) => this.ui.toast(t.text, t.tone));
    session.on("served", (m) => {
      this.ui.served(m);
      this.sfx("ding");
    });
    session.on("ping", (p) => {
      this.ui.toast(`${p.name}: ${PING_TEXT[p.preset]}`, "info");
      this.sfx("click");
      if (p.point) this.addMarker(p.point);
    });
    session.on("summary", (m) => {
      this.setMenuOpen(true);
      this.ui.summary(m, () => {
        this.ui.hideScreen();
        this.setMenuOpen(false);
      });
    });
    session.on("drop", () => {
      this.input.clear();
      this.local.clearOutbox();
      this.endCapture();
    });
    session.on("reconnect", () => {
      this.snapped = false;
      this.ui.toast("Reconnected", "success");
    });
    session.on("leave", ({ code, reason }) => {
      if (!this.disposed) this.hooks.leave(reason ?? "", code);
    });

    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("resize", this.onResize);
    window.visualViewport?.addEventListener("resize", this.onResize);
    engine.onContextLostObservable.add(() => this.ui.setBanner("Graphics paused — restoring…"));
    engine.onContextRestoredObservable.add(() => this.ui.setBanner(null));

    this.audio.setupSizzles(GRILL_ZONES.map((z) => ({ x: (z.rect.minX + z.rect.maxX) / 2, y: z.y, z: (z.rect.minZ + z.rect.maxZ) / 2 })));
    this.input.enabled = true;
    this.ui.setHudVisible(true);
    this.onState();
    engine.runRenderLoop(() => {
      this.frame();
      scene.render();
    });
  }

  // ---------------------------------------------------------------------------------------
  // Settings & lifecycle

  applySettings(s: Settings): void {
    this.settings = s;
    this.input.updateSettings(s);
    this.touch?.applySettings(s);
    this.audio.applySettings(s);
    this.camera.fov = (s.fov * Math.PI) / 180;
    this.ticketsVisible = s.showTicketOverlay;
    this.applyRenderScale();
  }

  /**
   * Restrained post-processing per preset: anti-aliasing everywhere, gentle bloom, vignette and
   * film grain on desktop presets, SSAO contact shading and sharpening on high. Motion blur is
   * never enabled by default.
   */
  private setupPostProcessing(settings: Settings): void {
    const preset = settings.graphics;
    if (preset === "low") return;
    const hdr = preset !== "tablet";
    if (preset === "high" && SSAO2RenderingPipeline.IsSupported) {
      // Contact shading for dynamic objects (food on counters, feet on the floor); the static
      // restaurant already carries baked AO.
      const ssao = new SSAO2RenderingPipeline("ssao", this.scene, { ssaoRatio: 0.5, blurRatio: 1 }, [this.camera]);
      ssao.radius = 0.35;
      ssao.totalStrength = 0.9;
      ssao.base = 0.15;
      ssao.samples = 12;
      ssao.maxZ = 30;
      ssao.expensiveBlur = false;
    }
    const p = new DefaultRenderingPipeline("post", hdr, this.scene, [this.camera]);
    p.fxaaEnabled = true;
    p.samples = preset === "high" ? 4 : 1;
    p.bloomEnabled = (preset === "medium" || preset === "high") && !settings.reducedEffects;
    p.bloomThreshold = 0.85;
    p.bloomWeight = 0.18;
    p.bloomKernel = 48;
    p.bloomScale = 0.5;
    p.imageProcessingEnabled = true;
    p.imageProcessing.toneMappingEnabled = true;
    p.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    p.imageProcessing.exposure = 1.25;
    p.imageProcessing.contrast = 1.12;
    p.imageProcessing.vignetteEnabled = preset !== "tablet";
    p.imageProcessing.vignetteWeight = 1.1;
    p.imageProcessing.vignetteColor = new Color4(0.08, 0.03, 0.02, 0);
    p.sharpenEnabled = preset === "high";
    p.sharpen.edgeAmount = 0.18;
    // Faint animated film grain: breaks up banding in the dark dining room on 8-bit displays.
    p.grainEnabled = (preset === "medium" || preset === "high") && !settings.reducedEffects;
    p.grain.intensity = 3.5;
    p.grain.animated = true;
  }

  private applyRenderScale(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.settings.graphics === "high" ? 2 : 1.5);
    this.engine.setHardwareScalingLevel(1 / (dpr * this.settings.renderScale));
    this.engine.resize();
  }

  setMenuOpen(open: boolean): void {
    this.menuOpen = open;
    this.input.enabled = !open;
    this.input.clear();
    this.local.clearOutbox();
    this.touch?.reset();
    this.touch?.setVisible(!open);
    this.endCapture();
    this.session.sendControl(MSG.away, { away: open });
    if (open) this.input.releaseLock();
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      // Backgrounded / screen locked: clear movement and manipulation input.
      this.input.clear();
      this.local.clearOutbox();
      this.endCapture();
      this.session.sendControl(MSG.away, { away: true });
      void this.audio.suspend();
    } else {
      this.session.sendControl(MSG.away, { away: this.menuOpen });
      this.snapped = false;
      if (!this.audio.running) {
        this.ui.setBanner("Tap to resume audio", { label: "Resume audio", run: () => void this.audio.unlock().then(() => this.ui.setBanner(null)) });
      }
    }
  };

  private onResize = (): void => {
    this.engine.resize();
  };

  dispose(): void {
    this.disposed = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("resize", this.onResize);
    window.visualViewport?.removeEventListener("resize", this.onResize);
    this.input.enabled = false;
    this.input.releaseLock();
    this.touch?.el.remove();
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.local.dispose();
    this.ui.setHudVisible(false);
  }

  // ---------------------------------------------------------------------------------------
  // Authoritative state

  private onState(): void {
    const state = this.session.state;
    if (!state?.players) return;
    const now = performance.now();
    this.clock.observe(state.tick, now);
    const tick = state.tick;

    for (const [id, p] of state.players) {
      if (id === this.session.sessionId) {
        if (!this.snapped) {
          this.local.snapTo({ x: p.x, y: p.y, z: p.z });
          this.yaw = p.yaw;
          this.pitch = p.pitch;
          this.snapped = true;
        } else {
          const heldKind = this.heldKind();
          this.local.reconcile(p, 1 / NET.tickHz, heldKind === "tray" ? PLAYER.carrySpeedFactor : 1);
        }
        if (p.held !== this.lastHeldServer) {
          this.lastHeldServer = p.held;
          if (this.heldOverride && this.heldOverride.id === (p.held || null)) this.clearHeldOverride();
        }
        continue;
      }
      let av = this.avatars.get(id);
      if (!av) {
        av = new AvatarView(this.scene, this.restaurant.materials, id, p.color);
        this.avatars.set(id, av);
        this.avatarBuffers.set(id, new SnapshotBuffer());
        this.restaurant.registerCasters(av.castMeshes);
      }
      const q = Quaternion.RotationYawPitchRoll(p.yaw, 0, 0);
      this.avatarBuffers.get(id)!.push(tick, { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w });
    }
    for (const id of [...this.avatars.keys()]) {
      if (!state.players.has(id)) {
        this.avatars.get(id)!.dispose();
        this.avatars.delete(id);
        this.avatarBuffers.delete(id);
      }
    }

    for (const [id, it] of state.items) {
      let view = this.items.get(id);
      if (!view) {
        view = new ItemView(this.scene, this.restaurant.materials, id, it.kind as ItemKind);
        this.items.set(id, view);
        this.itemBuffers.set(id, new SnapshotBuffer());
        this.restaurant.registerCasters(view.meshes());
      }
      this.itemBuffers.get(id)!.push(tick, { x: it.x, y: it.y, z: it.z, qx: it.qx, qy: it.qy, qz: it.qz, qw: it.qw });
      view.setAppearance(ITEMS[it.kind as ItemKind]?.food ? readFoodBytes(it) : null, it);
      const po = this.placeOverride.get(id);
      if (po && !it.holder && Math.hypot(it.x - po.x, it.z - po.z) < 0.25) this.placeOverride.delete(id);
    }
    for (const id of [...this.items.keys()]) {
      if (!state.items.has(id)) {
        this.items.get(id)!.dispose();
        this.items.delete(id);
        this.itemBuffers.delete(id);
        this.placeOverride.delete(id);
      }
    }

    for (const [id, c] of state.customers) {
      if (this.customers.has(id)) continue;
      const view = new CustomerView(this.scene, this.restaurant.materials, id, c.seed);
      this.customers.set(id, view);
      this.restaurant.registerCasters(view.castMeshes as Mesh[]);
    }
    for (const id of [...this.customers.keys()]) {
      if (!state.customers.has(id)) {
        this.customers.get(id)!.dispose();
        this.customers.delete(id);
      }
    }

    const open = [...state.orders.values()].filter((o) => o.status === "open").length;
    if (open > this.orderCount) this.sfx("ticket");
    this.orderCount = open;
  }

  private me() {
    return this.session.state?.players?.get(this.session.sessionId);
  }

  /** Locally predicted held item id (optimistic until the server confirms or rejects). */
  private heldId(): string | null {
    if (this.heldOverride && performance.now() < this.heldOverride.until) return this.heldOverride.id;
    if (this.heldOverride) this.clearHeldOverride();
    const h = this.me()?.held ?? "";
    return h || null;
  }

  private heldKind(): ItemKind | null {
    const id = this.heldId();
    if (id) return (this.session.state.items.get(id)?.kind as ItemKind) ?? null;
    if (this.heldOverride?.kind) return this.heldOverride.kind;
    return null;
  }

  private heldItem(): ItemState | null {
    const id = this.heldId();
    return id ? (this.session.state.items.get(id) ?? null) : null;
  }

  private clearHeldOverride(): void {
    this.heldOverride = null;
    this.spawnGhost?.dispose();
    this.spawnGhost = null;
  }

  // ---------------------------------------------------------------------------------------
  // Frame

  private frame(): void {
    if (this.disposed) return;
    const dtMs = Math.min(100, this.engine.getDeltaTime());
    const dt = dtMs / 1000;
    const now = performance.now();
    const state = this.session.state;
    if (!state?.players) return;
    const paused = state.paused;
    const connected = this.session.connected;

    // Look and held-object manipulation.
    const f = this.input.frame();
    const holding = this.heldId() !== null || this.heldOverride?.kind != null;
    if (!this.capture) {
      if (this.input.rotating && holding) {
        this.rotYaw = wrapAngle(this.rotYaw + f.rotDX);
        this.rotPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.rotPitch + f.rotDY));
      }
      // Wrapped: the yaw goes out in every move sample and place (an endless turn must stay valid).
      this.yaw = wrapAngle(this.yaw + f.lookDX);
      this.pitch = Math.max(-PLAYER.maxPitch, Math.min(PLAYER.maxPitch, this.pitch + f.lookDY));
    }
    if (f.hold !== 0) this.hold = InputManager.clampHold(this.hold + f.hold);
    if (!holding) {
      this.rotYaw = 0;
      this.rotPitch = 0;
    }

    // Predicted movement at the fixed simulation rate.
    const canMove = !paused && connected && !this.menuOpen && this.snapped;
    const buttons = (f.sprint ? BUTTON_SPRINT : 0) | (f.crouch ? BUTTON_CROUCH : 0);
    const speedFactor = this.heldKind() === "tray" ? PLAYER.carrySpeedFactor : 1;
    this.stepper.advance(dtMs, (h) => {
      if (!canMove) return;
      this.local.step({ mx: f.moveX, mz: f.moveZ, yaw: this.yaw, pitch: this.pitch, buttons }, h, speedFactor);
    });
    this.local.decayOffset(dt);

    // ~30 input messages per second, each carrying the samples simulated since the last one.
    this.sendAccumulator += dtMs;
    if (this.sendAccumulator >= 1000 / NET.inputSendHz) {
      this.sendAccumulator %= 1000 / NET.inputSendHz;
      while (this.local.outboxSize > 0) {
        const samples = this.local.drainOutbox(NET.maxSamplesPerMessage);
        this.session.sendInput({ samples, hold: this.hold, rotYaw: this.rotYaw, rotPitch: this.rotPitch });
      }
    }
    this.flushControls(dtMs);

    // Camera.
    const m = this.local.motor.state;
    const speed = Math.hypot(m.vx, m.vz);
    this.moving = canMove ? Math.min(1, speed / PLAYER.walkSpeed) : 0;
    this.crouchBlend += ((f.crouch ? 1 : 0) - this.crouchBlend) * Math.min(1, dt * 10);
    const eyeH = PLAYER.eyeHeight + (PLAYER.crouchEyeHeight - PLAYER.eyeHeight) * this.crouchBlend;
    const bob = this.settings.headBob * this.moving * Math.sin(now / 160) * 0.025;
    const camPos = new Vector3(m.x + this.local.offset.x, m.y + this.local.offset.y + eyeH + bob, m.z + this.local.offset.z);
    this.camera.position.copyFrom(camPos);
    this.camera.rotation.set(this.pitch, this.yaw, 0);

    // Remote players.
    const renderTick = this.clock.renderTick(now);
    this.clock.tick(dtMs, NET.interpolationDelayMs);
    for (const [id, av] of this.avatars) {
      const p = state.players.get(id);
      const buf = this.avatarBuffers.get(id)!;
      if (!p) continue;
      if (!buf.sample(renderTick, TMP_POSE)) this.clock.reportUnderrun();
      const label = `${p.name}${p.platform === "touch" ? " · tablet" : ""}${p.away ? " · away" : ""}${p.admin ? " ★" : ""}`;
      av.update(TMP_POSE.x, TMP_POSE.y, TMP_POSE.z, p.yaw, p.pitch, p.crouch, p.held !== "", label, !p.connected);
    }

    // Customers: poses come from their replicated phase and the render clock.
    if (state.paused) this.customerFreeze ??= renderTick;
    else this.customerFreeze = null;
    const custTick = this.customerFreeze ?? renderTick;
    let nearDoor = Infinity;
    for (const [id, view] of this.customers) {
      const c = state.customers.get(id);
      if (!c) continue;
      const pose = customerPose({ phase: c.phase as CustomerPhase, phaseAt: c.phaseAt, spot: c.spot, seed: c.seed, angry: c.angry }, custTick);
      const order = c.order ? state.orders.get(c.order) : undefined;
      const showTicket = order && (c.phase === "waiting" || c.phase === "collecting") ? order.number : null;
      view.update(pose, showTicket, dt);
      nearDoor = Math.min(nearDoor, Math.hypot(pose.x, pose.z - FRONT_DOOR.z));
    }
    const doorTarget = nearDoor < FRONT_DOOR.openDistance ? 1 : 0;
    this.doorOpen += (doorTarget - this.doorOpen) * Math.min(1, dt * (doorTarget ? 4 : 1.6));
    this.restaurant.setFrontDoor(this.doorOpen);

    // Items: roots first, then stacked layers relative to their root.
    const eye = new Vector3(m.x + this.local.offset.x, m.y + eyeH, m.z + this.local.offset.z);
    const heldId = this.heldId();
    const stacks = new Map<string, ItemState[]>();
    for (const [id, it] of state.items) {
      if (it.root) {
        const list = stacks.get(it.root) ?? [];
        list.push(it);
        stacks.set(it.root, list);
        continue;
      }
      const view = this.items.get(id);
      if (!view) continue;
      if (id === heldId) {
        this.poseHeld(view, eye, it.kind as ItemKind);
      } else if (this.placeOverride.has(id) && now < this.placeOverride.get(id)!.until) {
        const po = this.placeOverride.get(id)!;
        view.setPose(po.x, po.y, po.z, Quaternion.RotationYawPitchRoll(this.yaw, 0, 0));
      } else {
        if (!this.itemBuffers.get(id)!.sample(renderTick, TMP_POSE)) this.clock.reportUnderrun();
        view.setPose(TMP_POSE.x, TMP_POSE.y, TMP_POSE.z, new Quaternion(TMP_POSE.qx, TMP_POSE.qy, TMP_POSE.qz, TMP_POSE.qw));
      }
    }
    for (const [rootId, layers] of stacks) {
      const rootView = this.items.get(rootId);
      const rootState = state.items.get(rootId);
      if (!rootView || !rootState) continue;
      layers.sort((a, b) => a.layer - b.layer);
      const kinds = [rootState.kind as ItemKind, ...layers.map((l) => l.kind as ItemKind)];
      const offsets = stackOffsets(kinds);
      const q = rootView.root.rotationQuaternion!;
      const fwd = rootState.kind === "spatula" ? 0.07 : 0;
      layers.forEach((layer, i) => {
        const id = [...state.items.entries()].find(([, v]) => v === layer)?.[0];
        const v = id ? this.items.get(id) : undefined;
        if (!v) return;
        const local = new Vector3(0, offsets[i + 1]!, fwd);
        const world = local.rotateByQuaternionToRef(q, new Vector3()).addInPlace(rootView.root.position);
        v.setPose(world.x, world.y, world.z, q);
      });
    }
    if (this.spawnGhost) this.poseHeld(this.spawnGhost, eye, this.spawnGhost.kind);

    // Targeting, labels and placement preview.
    this.updateTarget();

    // Hands follow the held object.
    const heldView = heldId ? this.items.get(heldId) : this.spawnGhost;
    let heldLocal: Vector3 | null = null;
    const kind = this.heldKind();
    if (heldView && kind) {
      const inv = this.camera.getWorldMatrix().clone().invert();
      heldLocal = Vector3.TransformCoordinates(heldView.root.position, inv);
    }
    this.hands.update(dt, heldLocal, kind ? ITEMS[kind].grip : null, this.moving, this.settings.headBob);

    // Equipment with predicted overrides so local manipulation feels immediate.
    const knobBackup: number[] = [];
    state.grill.forEach((g, i) => {
      knobBackup[i] = g.knob;
      const o = this.knobOverride.get(i);
      if (o && now < o.until) (g as { knob: number }).knob = o.value;
    });
    const drawerBackup = state.drawer;
    if (this.drawerOverride && now < this.drawerOverride.until) (state as { drawer: number }).drawer = this.drawerOverride.value;
    this.restaurant.update(state, dt);
    state.grill.forEach((g, i) => ((g as { knob: number }).knob = knobBackup[i]!));
    (state as { drawer: number }).drawer = drawerBackup;

    // Audio: sizzle per zone from authoritative cooking state; listener follows the camera.
    const levels = GRILL_ZONES.map(() => 0);
    const smoke: SmokeSource[] = [];
    for (const [id, it] of state.items) {
      if (it.zone < 0 || it.root) continue;
      const food = readFoodBytes(it);
      const level = sizzleLevel(it.kind as ItemKind, food, state.grill[it.zone]?.temp ?? 0);
      levels[it.zone] = Math.min(1, levels[it.zone]! + level);
      const p = this.items.get(id)?.root.position;
      if (p) smoke.push({ x: p.x, y: p.y + (ITEMS[it.kind as ItemKind]?.layerHeight ?? 0.02) / 2, z: p.z, level, burn: food.burn });
    }
    this.smoke?.update(smoke, paused);
    levels.forEach((l, i) => this.audio.setSizzle(i, paused ? 0 : l));
    const fwd = lookDirection(this.yaw, this.pitch);
    this.audio.setListener(camPos.x, camPos.y, camPos.z, fwd.x, fwd.y, fwd.z);

    for (const mk of [...this.markers]) {
      if (now > mk.until) {
        mk.mesh.dispose();
        this.markers.splice(this.markers.indexOf(mk), 1);
      }
    }
    this.updateHud(now);
  }

  /** Mirrors the server's held-object placement using the local predicted eye. */
  private poseHeld(view: ItemView, eye: Vector3, kind: ItemKind): void {
    const dir = lookDirection(this.yaw, this.pitch);
    let d = this.hold;
    const hit = this.local.pw.castStatic(eye, dir, d + 0.1);
    if (hit !== null) d = Math.max(0.2, hit - 0.1);
    const drop = kind === "tray" ? 0.18 : 0.1;
    const q = kind === "tray" ? Quaternion.RotationYawPitchRoll(this.yaw, 0, 0) : Quaternion.RotationYawPitchRoll(this.yaw + this.rotYaw, this.rotPitch, 0);
    view.setPose(eye.x + dir.x * d, eye.y + dir.y * d - drop, eye.z + dir.z * d, q);
  }

  private updateHud(now: number): void {
    const state = this.session.state;
    this.ui.setStatus({
      code: this.session.welcome?.code ?? this.session.room.roomId,
      balance: state.balance,
      phase: state.phase,
      shiftTime: state.shiftTime,
      save: state.saveStatus,
      players: state.players.size,
      connected: this.session.connected,
    });
    if (state.paused) {
      const countdown = state.resumeTick > 0 ? Math.max(0, Math.ceil((state.resumeTick - this.clock.now(now)) / NET.tickHz)) : 0;
      const text = countdown > 0 ? `Resuming in ${countdown}…` : `Paused — ${state.pauseReason}`;
      this.ui.setBanner(text, countdown > 0 ? undefined : { label: "Resume", run: () => void this.session.command(MSG.pause, { action: "resume" }) });
    } else if (state.pauseVotes.length > 0) {
      this.ui.setBanner(`Pause vote ${state.pauseVotes.length}/${[...state.players.values()].filter((p) => p.connected).length}`);
    } else if (this.audio.running || !this.ui.screenOpen) {
      if (!document.hidden && this.audio.running) this.ui.setBanner(null);
    }
    const orders = [...state.orders.values()]
      .filter((o) => o.status === "open")
      .sort((a, b) => a.number - b.number)
      .map((o) => ({
        number: o.number,
        customer: o.customer,
        label: RECIPES[o.recipe as RecipeId]?.label ?? o.recipe,
        mods: [...o.modifiers].map((mm) => MODIFIERS[mm as ModifierId]?.label ?? mm),
        wait: state.shiftTime - o.createdAt,
        // Off by default: cooks are meant to learn the builds.
        hint: this.settings.showRecipeHints ? recipeHint(o.recipe as RecipeId) : undefined,
      }));
    this.ui.setTickets(this.ticketsVisible, orders);
    const locked = this.input.pointerLocked || this.input.lastPointer === "touch";
    this.ui.setClickToPlay(!locked && !this.menuOpen && !this.input.lockDenied && !this.touch, () => this.input.requestLock());
  }

  // ---------------------------------------------------------------------------------------
  // Targeting

  private rayFrom(x: number, y: number) {
    const r = this.canvas.getBoundingClientRect();
    return this.scene.createPickingRay(x - r.left, y - r.top, Matrix.Identity(), this.camera, false);
  }

  private pickAt(x: number, y: number): Target | null {
    const ray = this.rayFrom(x, y);
    const heldId = this.heldId();
    const heldStack = new Set<string>();
    if (heldId) {
      heldStack.add(heldId);
      for (const [id, it] of this.session.state.items) if (it.root === heldId) heldStack.add(id);
    }
    const hit = this.scene.pickWithRay(
      ray,
      (mesh) => {
        if (!mesh.isPickable || !mesh.isEnabled() || mesh.visibility < 0.9) return false;
        const pick = getPick(mesh);
        if (!pick) return false;
        if (pick.type === "item") {
          if (heldStack.has(pick.id)) return false;
          const st = this.session.state.items.get(pick.id);
          if (!st) return false;
          const root = st.root ? this.session.state.items.get(st.root) : st;
          if (root?.holder && root.holder !== this.session.sessionId && !root.offered) return false;
        }
        if (pick.type === "player" && pick.id === this.session.sessionId) return false;
        return true;
      },
      false,
    );
    if (!hit?.hit || !hit.pickedMesh || !hit.pickedPoint) return null;
    if (hit.distance > INTERACTION.reach + 0.25) return null;
    const pick = getPick(hit.pickedMesh);
    if (!pick || pick.type === "static") return null;
    return { pick, point: hit.pickedPoint.clone(), normal: hit.getNormal(true) ?? null, mesh: hit.pickedMesh };
  }

  private highlighted: ItemView | null = null;
  private highlightedMesh: AbstractMesh | null = null;

  private updateTarget(): void {
    const aim = this.input.aimPoint();
    this.target = this.menuOpen ? null : this.pickAt(aim.x, aim.y);
    const t = this.target;
    // Highlight.
    const item = t?.pick.type === "item" ? (this.items.get(t.pick.id) ?? null) : null;
    if (this.highlighted !== item) {
      this.highlighted?.setHighlighted(false);
      item?.setHighlighted(true);
      this.highlighted = item;
    }
    const mesh = t && t.pick.type !== "item" && t.pick.type !== "surface" ? t.mesh : null;
    if (this.highlightedMesh !== mesh) {
      if (this.highlightedMesh) this.highlightedMesh.renderOutline = false;
      if (mesh) {
        mesh.renderOutline = true;
        mesh.outlineColor = new Color3(1, 0.85, 0.4);
        mesh.outlineWidth = 0.004;
      }
      this.highlightedMesh = mesh;
    }

    // Placement preview and label.
    const kind = this.heldKind();
    const place = kind ? this.placement(kind, t) : null;
    const ghostKind = kind === "spatula" ? this.spatulaLoadKind() : kind;
    if (place && ghostKind && this.settings.assistedPlacement) {
      if (!this.previewGhost || this.previewGhost.kind !== ghostKind) {
        this.previewGhost?.dispose();
        this.previewGhost = new ItemView(this.scene, this.restaurant.materials, "ghost", ghostKind);
        this.previewGhost.setGhost(0.35);
        for (const mm of [this.previewGhost.root, ...this.previewGhost.root.getChildMeshes()]) mm.isPickable = false;
      }
      this.previewGhost.root.setEnabled(place.valid);
      this.previewGhost.setPose(place.pos.x, place.pos.y, place.pos.z, Quaternion.RotationYawPitchRoll(this.yaw, 0, 0));
    } else if (this.previewGhost) {
      this.previewGhost.root.setEnabled(false);
    }
    this.ui.setLabel(this.settings.showLabels ? this.labelFor(t, kind, place) : null);
    this.ui.setCrosshair(this.input.pointerLocked || (this.input.lastPointer === "touch" && !this.menuOpen), t !== null);
    this.ui.setInspect(this.inspecting ? this.inspectLines(t) : null);
  }

  private inspectLines(t: Target | null): string[] | null {
    const id = t?.pick.type === "item" ? t.pick.id : this.heldId();
    if (!id) return null;
    const it = this.session.state.items.get(id);
    if (!it) return null;
    const kind = it.kind as ItemKind;
    return describeFood(kind, ITEMS[kind].food ? readFoodBytes(it) : null);
  }

  /** Where the held item would go for a target, and whether the shared rules allow it. */
  private placement(kind: ItemKind, t: Target | null): { pos: Vector3; valid: boolean; onto?: string; trash?: boolean } | null {
    if (!t) return null;
    const moving = kind === "spatula" ? this.spatulaLoadKind() : null;
    const placeKind = moving ?? kind;
    if (isSauceBottle(kind) && t.pick.type === "item") return null;
    if (kind === "spatula" && !moving && t.pick.type === "item") return null;
    if (t.pick.type === "item") {
      const st = this.session.state.items.get(t.pick.id);
      if (!st) return null;
      const rootId = st.root || t.pick.id;
      const rootSt = this.session.state.items.get(rootId)!;
      const stack = [rootSt, ...[...this.session.state.items.values()].filter((x) => x.root === rootId).sort((a, b) => a.layer - b.layer)];
      const kinds = stack.map((s) => s.kind as ItemKind);
      const ok = canAddToStack(kinds, placeKind).ok;
      const top = stack[stack.length - 1]!;
      const topView = this.items.get([...this.session.state.items.entries()].find(([, v]) => v === top)?.[0] ?? "");
      const base = topView ? topView.root.position : new Vector3(top.x, top.y, top.z);
      const pos = new Vector3(base.x, base.y + ITEMS[top.kind as ItemKind].layerHeight / 2 + ITEMS[placeKind].layerHeight / 2, base.z);
      return { pos, valid: ok, onto: t.pick.id };
    }
    if (t.pick.type === "trash") {
      return { pos: t.point.clone(), valid: ITEMS[placeKind].food || placeKind === "tray", trash: true };
    }
    if (t.pick.type === "surface") {
      const p = { x: t.point.x, y: t.point.y, z: t.point.z };
      const up = (t.normal?.y ?? 0) > 0.7;
      const surf = surfaceAt(p, 0.04);
      const valid = up && surf !== null && !isNoPlaceArea(p) && !(surf.kind === "floor" && ITEMS[placeKind].food);
      return { pos: new Vector3(p.x, (surf?.y ?? p.y) + restingHeight(placeKind) + 0.002, p.z), valid };
    }
    return null;
  }

  private spatulaLoadKind(): ItemKind | null {
    const id = this.heldId();
    if (!id) return null;
    for (const it of this.session.state.items.values()) if (it.root === id && it.layer === 1) return it.kind as ItemKind;
    return null;
  }

  private labelFor(t: Target | null, kind: ItemKind | null, place: { valid: boolean; trash?: boolean; onto?: string } | null): string | null {
    const st = this.session.state;
    const touch = this.input.lastPointer === "touch";
    const click = touch ? "Tap" : "Click";
    if (kind === "spatula") {
      const load = this.spatulaLoadKind();
      if (load) return t && place?.valid ? `${click}: put ${ITEMS[load].label.toLowerCase()} down · ${touch ? "Swipe up/Use" : "E"}: flip` : `${touch ? "Swipe up/Use" : "E"}: flip`;
      if (t?.pick.type === "item") {
        const it = st.items.get(t.pick.id);
        const k = it?.kind as ItemKind | undefined;
        if (k && (isPatty(k) || k === "bacon")) return `${click}: slide under · ${touch ? "Use" : "E"}: quick flip`;
        if (k && ITEMS.spatula.accepts.includes(k)) return `${click}: slide under`;
      }
    }
    if (kind && isSauceBottle(kind) && t?.pick.type === "item") return `${touch ? "Press and hold" : "Hold click"}: squeeze ${ITEMS[kind].label.toLowerCase()}`;
    if (kind && t?.pick.type === "player") return `${touch ? "Use" : "E"}: hand over`;
    if (kind && place) {
      if (!place.valid) return place.trash ? "Can't bin that" : "Can't put that there";
      if (place.trash) return "Throw away";
      if (place.onto) return "Add to stack";
      const surf = t && surfaceAt({ x: t.point.x, y: t.point.y, z: t.point.z }, 0.04);
      return surf?.kind === "grill" ? "Place on grill" : surf?.kind === "pickup" ? "Serve at pickup" : "Place";
    }
    if (!t) return kind ? (touch ? "Set down: free surface" : "Q: set down") : null;
    switch (t.pick.type) {
      case "item": {
        const it = st.items.get(t.pick.id);
        if (!it) return null;
        const root = it.root ? st.items.get(it.root) : it;
        if (root?.offered && root.holder !== this.session.sessionId) return `${click}: take ${ITEMS[it.kind as ItemKind].label.toLowerCase()}`;
        const pickingStack = it.root && !this.hasChild(t.pick.id) ? ITEMS[it.kind as ItemKind].label : ITEMS[(root?.kind ?? it.kind) as ItemKind].label;
        return `${click}: pick up ${pickingStack.toLowerCase()}`;
      }
      case "dispenser": {
        const d = DISPENSERS.find((x) => x.id === (t.pick as { id: string }).id);
        if (d?.requiresDrawer !== undefined && st.drawer < d.requiresDrawer) return "Open the drawer first";
        return `${click}: take ${ITEMS[(t.pick as { kind: ItemKind }).kind].label.toLowerCase()}`;
      }
      case "knob":
        return this.settings.simpleInteractions ? `${click}: step heat` : "Drag: turn heat";
      case "drawer":
        return this.settings.simpleInteractions ? `${click}: open/close` : "Drag: pull drawer";
      case "switch":
        return `${click}/${touch ? "Use" : "E"}: ${st.phase === "open" ? "close up" : "open restaurant"}`;
      case "trash":
        return null;
      case "player":
        return null;
      default:
        return null;
    }
  }

  private hasChild(id: string): boolean {
    for (const it of this.session.state.items.values()) if (it.on === id) return true;
    return false;
  }

  // ---------------------------------------------------------------------------------------
  // Actions

  private sfx(kind: Sfx, at?: { x: number; y: number; z: number }): void {
    if (this.settings.reducedEffects && (kind === "ticket" || kind === "knob")) return;
    this.audio.play(kind, at);
  }

  private async run(type: string, payload: Record<string, unknown>, onFail?: () => void): Promise<ResultMessage> {
    const r = await this.session.command(type, payload);
    if (!r.ok) {
      onFail?.();
      if (r.reason) this.ui.toast(r.reason, "warn", 2200);
      this.sfx("error");
    }
    return r;
  }

  private primaryDown(x: number, y: number, kind: "mouse" | "touch"): boolean {
    if (this.menuOpen) return false;
    void this.audio.unlock();
    const t = this.pickAt(x, y);
    const heldKind = this.heldKind();
    this.pressBeganHolding = heldKind !== null;
    // Continuous manipulation targets capture the gesture on both mouse and touch.
    if (!heldKind && t?.pick.type === "knob") {
      if (this.settings.simpleInteractions) {
        if (kind === "mouse") this.stepKnob(t.pick.zone);
        return kind === "touch";
      }
      const zone = t.pick.zone;
      this.capture = { type: "knob", zone, value: this.session.state.grill[zone]?.knob ?? 0 };
      return true;
    }
    if (!heldKind && t?.pick.type === "drawer") {
      if (this.settings.simpleInteractions) {
        if (kind === "mouse") this.toggleDrawer();
        return kind === "touch";
      }
      this.capture = { type: "drawer", value: this.session.state.drawer };
      this.sfx("drawer");
      return true;
    }
    if (heldKind && isSauceBottle(heldKind) && t?.pick.type === "item") {
      this.capture = { type: "squeeze", target: t.pick.id };
      this.controlSendTimer = 0;
      this.sfx("squeeze");
      return true;
    }
    if (kind === "touch") return false;
    this.activate(t, "press");
    return false;
  }

  private primaryUp(x: number, y: number, kind: "mouse" | "touch", captured: boolean, moved: boolean): void {
    if (captured) {
      if (this.capture === null && this.settings.simpleInteractions && kind === "touch" && !moved) {
        const t = this.pickAt(x, y);
        if (t?.pick.type === "knob") this.stepKnob(t.pick.zone);
        if (t?.pick.type === "drawer") this.toggleDrawer();
      }
      this.endCapture();
      return;
    }
    if (this.menuOpen) return;
    const t = this.pickAt(x, y);
    if (kind === "touch") {
      // A tap is a complete toggle-to-hold action; lifting a finger never drops anything.
      void this.audio.unlock();
      this.activate(t, "tap");
      return;
    }
    // Desktop hold-to-carry: releasing over a valid spot places the item.
    if (!this.settings.toggleToHold && this.heldKind() && !ITEMS[this.heldKind()!].tool) {
      const place = this.placement(this.heldKind()!, t);
      if (place?.valid) this.place(t!, place);
      else if (!this.pressBeganHolding && place && !place.valid) this.ui.setLabel("Can't put that there — Q to set down");
    }
  }

  /** Shared press/tap behaviour. */
  private activate(t: Target | null, mode: "press" | "tap"): void {
    const heldKind = this.heldKind();
    const st = this.session.state;
    if (heldKind) {
      if (heldKind === "spatula" && !this.spatulaLoadKind() && t?.pick.type === "item") {
        const it = st.items.get(t.pick.id);
        if (it && ITEMS.spatula.accepts.includes(it.kind as ItemKind)) {
          const rootId = it.root || t.pick.id;
          void this.run(MSG.spatula, { action: "slide", item: rootId, rev: st.items.get(rootId)?.rev ?? 0 }).then((r) => r.ok && this.sfx("grab"));
          return;
        }
      }
      const toolOrToggle = ITEMS[heldKind].tool || this.settings.toggleToHold || mode === "tap" || this.pressBeganHolding;
      if (!toolOrToggle) return;
      const place = this.placement(heldKind, t);
      if (place?.valid && t) this.place(t, place);
      else if (t?.pick.type === "switch") this.toggleShift();
      else if (place && !place.valid) this.ui.toast("Can't put that there", "warn", 1500);
      return;
    }
    if (!t) return;
    switch (t.pick.type) {
      case "item": {
        const it = st.items.get(t.pick.id);
        if (!it) return;
        const root = it.root ? st.items.get(it.root) : it;
        const takesLayer = it.root !== "" && !this.hasChild(t.pick.id) && !(root?.holder);
        const holdId = takesLayer ? t.pick.id : it.root || t.pick.id;
        this.heldOverride = { id: holdId, kind: null, until: performance.now() + 1500 };
        void this.run(MSG.grab, { item: t.pick.id, rev: it.rev }, () => this.clearHeldOverride()).then((r) => r.ok && this.sfx("grab"));
        return;
      }
      case "dispenser": {
        const d = t.pick;
        this.clearHeldOverride();
        this.heldOverride = { id: null, kind: d.kind, until: performance.now() + 1500 };
        this.spawnGhost = new ItemView(this.scene, this.restaurant.materials, "spawn", d.kind);
        for (const mm of [this.spawnGhost.root, ...this.spawnGhost.root.getChildMeshes()]) mm.isPickable = false;
        void this.run(MSG.grab, { dispenser: d.id }, () => this.clearHeldOverride()).then((r) => {
          if (r.ok) {
            this.sfx("grab");
            // Keep the ghost until the real item arrives in our hands.
            if (this.heldOverride?.kind) this.heldOverride = { id: this.me()?.held || null, kind: null, until: performance.now() + 1500 };
            this.spawnGhost?.dispose();
            this.spawnGhost = null;
          }
        });
        return;
      }
      case "switch":
        this.toggleShift();
        return;
      default:
        return;
    }
  }

  private place(t: Target, place: { pos: Vector3; valid: boolean; onto?: string; trash?: boolean }): void {
    const heldId = this.heldId();
    const kind = this.heldKind();
    if (!kind) return;
    const point = place.onto ? (this.items.get(place.onto)?.root.position ?? t.point) : t.point;
    const movingId = kind === "spatula" ? this.spatulaLoadId() : heldId;
    if (movingId && !place.trash) this.placeOverride.set(movingId, { x: place.pos.x, y: place.pos.y, z: place.pos.z, until: performance.now() + 900 });
    if (kind !== "spatula") this.heldOverride = { id: null, kind: null, until: performance.now() + 900 };
    void this.run(
      MSG.place,
      { point: { x: point.x, y: place.onto ? point.y : t.point.y, z: point.z }, ...(place.onto ? { onto: place.onto } : {}), yaw: this.yaw },
      () => {
        if (movingId) this.placeOverride.delete(movingId);
        this.clearHeldOverride();
      },
    ).then((r) => r.ok && this.sfx(place.trash ? "trash" : "place", { x: point.x, y: point.y, z: point.z }));
  }

  private spatulaLoadId(): string | null {
    const id = this.heldId();
    if (!id) return null;
    for (const [iid, it] of this.session.state.items) if (it.root === id && it.layer === 1) return iid;
    return null;
  }

  private toggleShift(): void {
    const open = this.session.state.phase === "open";
    void this.run(MSG.shift, { action: open ? "close" : "open" }).then((r) => r.ok && this.sfx("click"));
  }

  private stepKnob(zone: number): void {
    const cur = this.session.state.grill[zone]?.knob ?? 0;
    const steps = [0, 0.35, 0.65, 0.85];
    const next = steps.find((s) => s > cur + 0.05) ?? 0;
    this.knobOverride.set(zone, { value: next, until: performance.now() + 1500 });
    this.pendingControl = { type: "knob", zone, value: next, until: performance.now() + 1500 };
    this.sfx("knob");
  }

  private toggleDrawer(): void {
    const next = this.session.state.drawer > 0.5 ? 0 : 1;
    this.drawerOverride = { value: next, until: performance.now() + 1500 };
    this.pendingControl = { type: "drawer", value: next, until: performance.now() + 1500 };
    this.sfx("drawer");
  }

  private pendingControl: { type: "knob"; zone: number; value: number; until: number } | { type: "drawer"; value: number; until: number } | null = null;

  private captureMove(dx: number, dy: number): void {
    const c = this.capture;
    if (!c) return;
    const scale = this.input.lastPointer === "touch" ? 0.006 : 0.004;
    if (c.type === "knob") {
      // Interpret the drag in the knob's frame: right/up turns it up.
      const before = c.value;
      c.value = Math.max(0, Math.min(1, c.value + (dx - dy) * scale));
      if (Math.floor(before * 12) !== Math.floor(c.value * 12)) this.sfx("knob");
      this.knobOverride.set(c.zone, { value: c.value, until: performance.now() + 600 });
      this.pendingControl = { type: "knob", zone: c.zone, value: c.value, until: performance.now() + 600 };
    } else if (c.type === "drawer") {
      c.value = Math.max(0, Math.min(1, c.value + dy * scale * 1.2));
      this.drawerOverride = { value: c.value, until: performance.now() + 600 };
      this.pendingControl = { type: "drawer", value: c.value, until: performance.now() + 600 };
    }
  }

  private endCapture(): void {
    if (this.capture?.type === "knob") this.knobOverride.set(this.capture.zone, { value: this.capture.value, until: performance.now() + 500 });
    if (this.capture?.type === "drawer") this.drawerOverride = { value: this.capture.value, until: performance.now() + 500 };
    this.capture = null;
  }

  /** Streams continuous controls at ~20 Hz (latest value wins on the server). */
  private flushControls(dtMs: number): void {
    this.controlSendTimer -= dtMs;
    if (this.controlSendTimer > 0) return;
    this.controlSendTimer = 50;
    const now = performance.now();
    if (this.capture?.type === "squeeze") {
      this.session.sendControl(MSG.squeeze, { target: this.capture.target, intensity: 1 });
      if (Math.random() < 0.3) this.sfx("squeeze");
    }
    const pc = this.pendingControl;
    if (pc) {
      if (now > pc.until) this.pendingControl = null;
      else if (pc.type === "knob") this.session.sendControl(MSG.knob, { zone: pc.zone, value: pc.value });
      else this.session.sendControl(MSG.drawer, { value: pc.value });
    }
  }

  private onAction(a: Action): void {
    if (a === "pause") {
      this.hooks.openMenu();
      return;
    }
    if (this.menuOpen) return;
    void this.audio.unlock();
    const st = this.session.state;
    const t = this.target;
    const heldKind = this.heldKind();
    switch (a) {
      case "use":
      case "flick": {
        if (t?.pick.type === "switch" && a === "use") return this.toggleShift();
        if (heldKind && t?.pick.type === "player" && a === "use") {
          void this.run(MSG.offer, { to: t.pick.id }).then((r) => r.ok && this.ui.toast("Holding it out — your teammate can take it", "info", 1800));
          this.hold = INTERACTION.offerDistance;
          return;
        }
        if (heldKind === "spatula") {
          if (this.spatulaLoadKind()) {
            void this.run(MSG.spatula, { action: "flip" }).then((r) => r.ok && this.sfx("flip"));
            return;
          }
          if (t?.pick.type === "item") {
            const it = st.items.get(t.pick.id);
            const rootId = it?.root || t.pick.id;
            const rk = st.items.get(rootId)?.kind as ItemKind | undefined;
            if (rk && (isPatty(rk) || rk === "bacon")) {
              void this.run(MSG.spatula, { action: "assistFlip", item: rootId, rev: st.items.get(rootId)?.rev ?? 0 }).then((r) => r.ok && this.sfx("flip"));
              return;
            }
          }
        }
        if (a === "use" && !heldKind && t) this.activate(t, "tap");
        return;
      }
      case "setDown": {
        if (!heldKind) return;
        this.heldOverride = heldKind === "spatula" && this.spatulaLoadKind() ? this.heldOverride : { id: null, kind: null, until: performance.now() + 900 };
        void this.run(MSG.setDown, {}, () => this.clearHeldOverride()).then((r) => r.ok && this.sfx("place"));
        return;
      }
      case "inspect":
        this.inspecting = !this.inspecting || this.input.lastPointer !== "touch";
        if (this.input.lastPointer === "touch") setTimeout(() => (this.inspecting = false), 2500);
        return;
      case "ping":
        this.hooks.openPing();
        return;
      case "recipes":
        this.hooks.openRecipes();
        return;
      case "tickets":
        this.ticketsVisible = !this.ticketsVisible;
        this.settings.showTicketOverlay = this.ticketsVisible;
        saveSettings(this.settings);
        return;
      case "crouchToggle":
        return;
      default:
        return;
    }
  }

  sendPing(preset: PingPreset): void {
    const p = this.target?.point;
    void this.session.command(MSG.ping, { preset, ...(p ? { point: { x: p.x, y: p.y, z: p.z } } : {}) });
  }

  private addMarker(p: { x: number; y: number; z: number }): void {
    const mesh = MeshBuilder.CreateTorus("ping_marker", { diameter: 0.25, thickness: 0.02, tessellation: 24 }, this.scene);
    mesh.position.set(p.x, p.y + 0.02, p.z);
    mesh.material = this.restaurant.materials.solid("ping_mat", [0.2, 0.8, 1], 0.4, 0, [0.2, 0.7, 1]);
    mesh.isPickable = false;
    this.markers.push({ mesh, until: performance.now() + 4000 });
  }

  /** Debug/test surface (e2e tests read state through this). */
  debug(): Record<string, unknown> {
    const m = this.local.motor.state;
    return {
      sessionId: this.session.sessionId,
      code: this.session.welcome?.code,
      players: this.session.state.players.size,
      position: { x: m.x, y: m.y, z: m.z },
      held: this.heldId(),
      items: this.items.size,
      pending: this.local.pendingCount,
      drawCalls: this.drawCalls(),
      activeMeshes: this.scene.getActiveMeshes().length,
      fps: this.engine.getFps(),
    };
  }

  /** Per-frame draw calls, measured with instrumentation that is only enabled on request. */
  private drawCalls(): number | null {
    if (!this.instrumentation) {
      this.instrumentation = new SceneInstrumentation(this.scene);
      this.instrumentation.captureFrameTime = true;
      return null;
    }
    return this.instrumentation.drawCallsCounter.lastSecAverage || this.instrumentation.drawCallsCounter.current;
  }

  /** Test hook: aim the camera precisely. */
  debugLook(yaw: number, pitch: number): void {
    this.yaw = wrapAngle(yaw);
    this.pitch = pitch;
  }
}
