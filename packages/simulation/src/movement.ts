import { PLAYER } from "@ahb/data";
import { PLAYER_GROUPS, QUERY_STATIC, type PhysicsWorld } from "./physics.js";
import { clamp, type V3 } from "./vec.js";

export const BUTTON_SPRINT = 1;
export const BUTTON_CROUCH = 2;

/** One fixed-step (1/60 s) movement sample. Clients batch several per input message. */
export interface MoveSample {
  seq: number;
  /** Strafe intent, -1 (left) … 1 (right). */
  mx: number;
  /** Forward intent, -1 (back) … 1 (forward). */
  mz: number;
  yaw: number;
  pitch: number;
  buttons: number;
}

export const IDLE_SAMPLE: Omit<MoveSample, "seq" | "yaw" | "pitch"> = { mx: 0, mz: 0, buttons: 0 };

export interface MotorState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
}

/** Horizontal target velocity for an input sample. Shared by server and prediction. */
export function targetVelocity(sample: MoveSample, speedFactor = 1): { x: number; z: number } {
  let mx = clamp(sample.mx, -1, 1);
  let mz = clamp(sample.mz, -1, 1);
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  const crouch = (sample.buttons & BUTTON_CROUCH) !== 0;
  const sprint = !crouch && (sample.buttons & BUTTON_SPRINT) !== 0 && mz > 0.2;
  const speed = (crouch ? PLAYER.crouchSpeed : sprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed) * speedFactor;
  const s = Math.sin(sample.yaw);
  const c = Math.cos(sample.yaw);
  // forward = (sin yaw, 0, cos yaw); right = (cos yaw, 0, -sin yaw)
  return { x: (s * mz + c * mx) * speed, z: (c * mz - s * mx) * speed };
}

function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

const CAPSULE_CENTER = PLAYER.halfHeight + PLAYER.radius;

/**
 * Kinematic character motor built on Rapier's character controller. The server runs one per
 * player; the client runs one for its own player and replays unacknowledged samples after each
 * authoritative update.
 */
export class PlayerMotor {
  readonly state: MotorState;
  private readonly pw: PhysicsWorld;
  private readonly collider;
  private readonly controller;

  constructor(pw: PhysicsWorld, start: V3) {
    this.pw = pw;
    const { R, world } = pw;
    this.collider = world.createCollider(
      R.ColliderDesc.capsule(PLAYER.halfHeight, PLAYER.radius)
        .setTranslation(start.x, start.y + CAPSULE_CENTER, start.z)
        .setCollisionGroups(PLAYER_GROUPS),
    );
    this.controller = world.createCharacterController(PLAYER.controllerOffset);
    this.controller.setApplyImpulsesToDynamicBodies(false);
    this.controller.enableSnapToGround(PLAYER.snapToGround);
    this.controller.enableAutostep(PLAYER.autostepHeight, 0.2, false);
    this.controller.setMaxSlopeClimbAngle((45 * Math.PI) / 180);
    this.controller.setSlideEnabled(true);
    this.state = { x: start.x, y: start.y, z: start.z, vx: 0, vy: 0, vz: 0, grounded: true };
  }

  step(sample: MoveSample, dt: number, speedFactor = 1): MotorState {
    const s = this.state;
    const target = targetVelocity(sample, speedFactor);
    const maxDelta = PLAYER.acceleration * dt;
    s.vx = approach(s.vx, target.x, maxDelta);
    s.vz = approach(s.vz, target.z, maxDelta);
    s.vy = s.grounded ? -1 : Math.max(s.vy + PLAYER.gravity * dt, -20);

    this.controller.computeColliderMovement(
      this.collider,
      { x: s.vx * dt, y: s.vy * dt, z: s.vz * dt },
      undefined,
      QUERY_STATIC,
    );
    const move = this.controller.computedMovement();
    s.x += move.x;
    s.y += move.y;
    s.z += move.z;
    s.grounded = this.controller.computedGrounded();
    if (s.grounded) s.vy = 0;
    // Blocked horizontal motion loses its velocity so we do not "store" speed against walls.
    if (Math.abs(move.x) < Math.abs(s.vx * dt) * 0.5) s.vx = move.x / dt;
    if (Math.abs(move.z) < Math.abs(s.vz * dt) * 0.5) s.vz = move.z / dt;
    // Safety net: never fall out of the restaurant.
    if (s.y < -2) {
      s.y = 0.05;
      s.vy = 0;
    }
    this.collider.setTranslation({ x: s.x, y: s.y + CAPSULE_CENTER, z: s.z });
    return s;
  }

  /** Hard-sets position and velocity (reconciliation, teleports, respawn). */
  reset(next: Partial<MotorState> & { x: number; y: number; z: number }): void {
    Object.assign(this.state, next);
    this.collider.setTranslation({ x: next.x, y: next.y + CAPSULE_CENTER, z: next.z });
  }

  dispose(): void {
    this.pw.world.removeCharacterController(this.controller);
    this.pw.world.removeCollider(this.collider, false);
  }
}
