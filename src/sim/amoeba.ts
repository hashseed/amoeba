import { foodTint, randomTint, type CellTint, type Rgb } from '../palette';
import { angleDiff, clamp, noise1, type Rng } from './rng';

export const enum OrganelleKind {
  Nucleus = 0,
  ContractileVacuole = 1,
  FoodVacuole = 2,
  Droplet = 3,
}

export interface Organelle {
  kind: OrganelleKind;
  /** Offset from the cell centroid, in world px. */
  ox: number;
  oy: number;
  /** Resting offset the organelle relaxes back to. */
  rx: number;
  ry: number;
  r: number;
  baseR: number;
  /** Free-running phase for pulsing and wobble. */
  phase: number;
  tint: Rgb;
}

interface Pseudopod {
  angle: number;
  /** Angular half-width of the bulge, radians. */
  width: number;
  power: number;
  age: number;
  life: number;
}

/** Number of membrane samples around the cell. */
export const NODES = 48;
/** Hard cap so the renderer's data texture row always fits. */
export const MAX_ORGANELLES = 16;

const TAU = Math.PI * 2;

/**
 * An amoeba whose membrane is a radius function r(θ) sampled around a moving
 * centre. The cell lives in a viscous medium, so motion is overdamped and
 * calm. Pseudopods are bulges in r(θ); the centre then flows toward them while
 * the membrane stays put, so the body visibly catches up with each pseudopod.
 * A star-shaped outline can never tangle, however the forces add up.
 */
export class Amoeba {
  readonly xs = new Float32Array(NODES);
  readonly ys = new Float32Array(NODES);
  /** Membrane radius at angle i·2π/NODES around (cx, cy). */
  private readonly rs = new Float32Array(NODES);
  private readonly dr = new Float32Array(NODES);

  cx: number;
  cy: number;
  /** Rest radius; the target area is that of a circle of this radius. */
  radius: number;
  heading: number;
  /** Depth relative to the focal range, roughly -1 (far) to 1 (near). */
  z: number;
  private zTarget: number;
  private zTimer = 0;

  readonly tint: CellTint;
  readonly seed: number;
  readonly organelles: Organelle[] = [];
  private readonly pods: Pseudopod[] = [];
  private podTimer = 0;
  private time = 0;

  constructor(rng: Rng, x: number, y: number, radius: number) {
    this.cx = x;
    this.cy = y;
    this.radius = radius;
    this.seed = rng.int(1, 1 << 30);
    this.heading = rng.range(0, TAU);
    this.z = rng.range(-1, 1);
    this.zTarget = this.z;
    this.tint = randomTint(rng);
    for (let i = 0; i < NODES; i++) this.rs[i] = radius * (1 + 0.08 * Math.sin((i / NODES) * TAU * 3 + this.seed));
    this.updateOutline();
    this.spawnOrganelles(rng);
  }

  private spawnOrganelles(rng: Rng): void {
    const R = this.radius;
    const add = (kind: OrganelleKind, r: number, spread: number, tint: Rgb = this.tint.ink) => {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.sqrt(rng.next()) * spread * R;
      const ox = Math.cos(a) * d;
      const oy = Math.sin(a) * d;
      this.organelles.push({ kind, ox, oy, rx: ox, ry: oy, r, baseR: r, phase: rng.range(0, 10), tint });
    };

    add(OrganelleKind.Nucleus, R * rng.range(0.2, 0.26), 0.15);
    const cvs = rng.int(1, 3);
    for (let i = 0; i < cvs; i++) add(OrganelleKind.ContractileVacuole, R * rng.range(0.1, 0.15), 0.65);
    const foods = rng.int(2, 6);
    for (let i = 0; i < foods; i++) add(OrganelleKind.FoodVacuole, R * rng.range(0.08, 0.15), 0.7, foodTint(rng));
    const drops = rng.int(4, 8);
    for (let i = 0; i < drops; i++) add(OrganelleKind.Droplet, R * rng.range(0.025, 0.045), 0.75);
    this.organelles.length = Math.min(this.organelles.length, MAX_ORGANELLES);
  }

  step(dt: number, rng: Rng, bounds: { w: number; h: number }): void {
    this.time += dt;
    this.updateDepth(dt, rng);
    this.updatePods(dt, rng);
    this.steer(dt, bounds);
    this.reshape(dt);
    this.crawl(dt);
    this.updateOutline();
    this.updateOrganelles(dt);
  }

  /** Cells drift slowly up and down through the focal plane. */
  private updateDepth(dt: number, rng: Rng): void {
    this.zTimer -= dt;
    if (this.zTimer <= 0) {
      this.zTimer = rng.range(18, 40);
      this.zTarget = clamp(this.z + rng.range(-0.9, 0.9), -1, 1);
    }
    this.z += (this.zTarget - this.z) * Math.min(1, dt * 0.08);
  }

  private updatePods(dt: number, rng: Rng): void {
    this.podTimer -= dt;
    if (this.podTimer <= 0 && this.pods.length < 4) {
      this.podTimer = rng.range(1.5, 4);
      const branch = rng.next() < 0.35;
      this.pods.push({
        angle: this.heading + rng.gauss() * (branch ? 0.9 : 0.4),
        width: rng.range(0.2, 0.34),
        power: rng.range(0.18, 0.32) * this.radius,
        age: 0,
        life: rng.range(6, 12),
      });
    }
    for (let i = this.pods.length - 1; i >= 0; i--) {
      const p = this.pods[i];
      p.age += dt;
      if (p.age >= p.life) this.pods.splice(i, 1);
    }
  }

  /** Extends for the first part of its life, then holds while the body catches up. */
  private podEnvelope(p: Pseudopod): number {
    const t = p.age / p.life;
    return t < 0.45 ? Math.sin((t / 0.45) * Math.PI * 0.5) : Math.cos(((t - 0.45) / 0.55) * Math.PI * 0.5);
  }

  /** Heading wanders, follows the strongest pseudopod, and avoids the walls. */
  private steer(dt: number, bounds: { w: number; h: number }): void {
    let best = 0;
    let bestAngle = this.heading;
    for (const p of this.pods) {
      const e = this.podEnvelope(p) * p.power;
      if (e > best) {
        best = e;
        bestAngle = p.angle;
      }
    }
    let turn = angleDiff(bestAngle, this.heading) * 0.2;
    turn += noise1(this.time * 0.07, this.seed) * 0.15;

    const margin = this.radius * 2;
    let ax = 0;
    let ay = 0;
    if (this.cx < margin) ax += (margin - this.cx) / margin;
    if (this.cx > bounds.w - margin) ax -= (this.cx - (bounds.w - margin)) / margin;
    if (this.cy < margin) ay += (margin - this.cy) / margin;
    if (this.cy > bounds.h - margin) ay -= (this.cy - (bounds.h - margin)) / margin;
    if (ax !== 0 || ay !== 0) {
      turn += angleDiff(Math.atan2(ay, ax), this.heading) * Math.min(1, Math.hypot(ax, ay)) * 0.8;
    }
    this.heading += turn * dt;
  }

  /** Evolve r(θ): pseudopods push out, surface tension smooths, pressure keeps the area. */
  private reshape(dt: number): void {
    const { rs, dr } = this;
    const R = this.radius;
    let area = 0;
    for (let i = 0; i < NODES; i++) area += rs[i] * rs[i];
    area *= Math.PI / NODES;
    const targetArea = Math.PI * R * R;
    const pressure = ((targetArea - area) / targetArea) * R * 1.5;
    // Excess area (from a growing pseudopod) is drawn mostly from the rear, as
    // the trailing uroid retracts; a deficit inflates the cell evenly.
    const hx = Math.cos(this.heading);
    const hy = Math.sin(this.heading);
    let weightSum = 0;
    for (let i = 0; i < NODES; i++) weightSum += this.retractWeight(i, hx, hy);
    const weightNorm = NODES / weightSum;

    for (let i = 0; i < NODES; i++) {
      const r0 = rs[(i + NODES - 2) % NODES];
      const r1 = rs[(i + NODES - 1) % NODES];
      const r2 = rs[i];
      const r3 = rs[(i + 1) % NODES];
      const r4 = rs[(i + 2) % NODES];
      // Second- and fourth-order smoothing: rounds tips without flattening lobes.
      let d = (r1 + r3 - 2 * r2) * 0.5 - (r0 - 4 * r1 + 6 * r2 - 4 * r3 + r4) * 0.1;
      const ang = (i / NODES) * TAU;
      d += pressure > 0 ? pressure : pressure * this.retractWeight(i, hx, hy) * weightNorm;
      // The body stays plump: the membrane resists being pulled in past ~0.8 R.
      if (r2 < R * 0.8) d += (R * 0.8 - r2) * 1.2;
      // Slow low-frequency undulation so the outline is never a perfect circle.
      for (let k = 2; k <= 4; k++) d += R * 0.025 * Math.sin(k * ang + noise1(this.time * 0.05, this.seed + k) * 6);
      for (const p of this.pods) {
        const a = angleDiff(ang, p.angle) / p.width;
        d += Math.exp(-a * a) * this.podEnvelope(p) * p.power;
      }
      // Gentle pull back toward a round cell keeps arms from growing without end.
      d += (R - r2) * 0.03;
      dr[i] = d;
    }
    for (let i = 0; i < NODES; i++) rs[i] = Math.max(R * 0.3, rs[i] + dr[i] * dt);
  }

  /** How strongly node i gives up area: small at the leading edge, large at the rear. */
  private retractWeight(i: number, hx: number, hy: number): number {
    const ang = (i / NODES) * TAU;
    const back = -(Math.cos(ang) * hx + Math.sin(ang) * hy);
    return 0.25 + Math.max(0, back) * 1.75;
  }

  /** The centre flows toward active pseudopods; the membrane stays where it is. */
  private crawl(dt: number): void {
    let vx = 0;
    let vy = 0;
    for (const p of this.pods) {
      const e = this.podEnvelope(p) * (p.age / p.life);
      vx += Math.cos(p.angle) * e;
      vy += Math.sin(p.angle) * e;
    }
    const speed = this.radius * 0.09;
    this.shiftCentre(vx * speed * dt, vy * speed * dt);
  }

  /** Move the centre without moving the membrane, by re-expressing r(θ). */
  private shiftCentre(dx: number, dy: number): void {
    for (let i = 0; i < NODES; i++) {
      const ang = (i / NODES) * TAU;
      this.rs[i] = Math.max(this.radius * 0.3, this.rs[i] - (Math.cos(ang) * dx + Math.sin(ang) * dy));
    }
    this.cx += dx;
    this.cy += dy;
    for (const o of this.organelles) {
      // Organelles lag a little behind the flow.
      o.ox -= dx * 0.2;
      o.oy -= dy * 0.2;
    }
  }

  updateOutline(): void {
    for (let i = 0; i < NODES; i++) {
      const ang = (i / NODES) * TAU;
      this.xs[i] = this.cx + Math.cos(ang) * this.rs[i];
      this.ys[i] = this.cy + Math.sin(ang) * this.rs[i];
    }
  }

  /** Membrane radius in a given direction, linearly interpolated. */
  radiusAt(angle: number): number {
    const t = ((((angle / TAU) % 1) + 1) % 1) * NODES;
    const i = Math.floor(t) % NODES;
    const f = t - Math.floor(t);
    return this.rs[i] * (1 - f) + this.rs[(i + 1) % NODES] * f;
  }

  private updateOrganelles(dt: number): void {
    const R = this.radius;
    // Cytoplasm streams toward the active pseudopods.
    let sx = 0;
    let sy = 0;
    for (const p of this.pods) {
      const e = this.podEnvelope(p);
      sx += Math.cos(p.angle) * e;
      sy += Math.sin(p.angle) * e;
    }
    const orgs = this.organelles;
    for (let i = 0; i < orgs.length; i++) {
      const o = orgs[i];
      o.phase += dt;
      const stream = o.kind === OrganelleKind.Nucleus ? 0.01 : 0.025;
      let vx = (o.rx - o.ox) * 0.25 + sx * stream * R;
      let vy = (o.ry - o.oy) * 0.25 + sy * stream * R;
      vx += noise1(o.phase * 0.3, this.seed + i * 17) * 0.05 * R;
      vy += noise1(o.phase * 0.3 + 50, this.seed + i * 17) * 0.05 * R;

      // Organelles jostle rather than overlap.
      for (let j = 0; j < orgs.length; j++) {
        if (j === i) continue;
        const q = orgs[j];
        const dx = o.ox - q.ox;
        const dy = o.oy - q.oy;
        const d = Math.hypot(dx, dy) || 0.01;
        const overlap = o.r + q.r + 2 - d;
        if (overlap > 0) {
          vx += (dx / d) * overlap * 1.5;
          vy += (dy / d) * overlap * 1.5;
        }
      }
      o.ox += vx * dt;
      o.oy += vy * dt;

      if (o.kind === OrganelleKind.ContractileVacuole) {
        // Slowly fills, then empties in a quick squeeze.
        const period = 9 + (i % 3);
        const t = (o.phase % period) / period;
        o.r = o.baseR * (t < 0.93 ? 0.35 + 0.65 * Math.pow(t / 0.93, 0.7) : 1 - ((t - 0.93) / 0.07) * 0.65);
      }

      // Stay inside the membrane, clear of the hyaline rim.
      const d = Math.hypot(o.ox, o.oy);
      const limit = Math.max(0, this.radiusAt(Math.atan2(o.oy, o.ox)) - o.r - R * 0.14);
      if (d > limit && d > 0) {
        o.ox *= limit / d;
        o.oy *= limit / d;
      }
    }
  }

  /** Push the membrane inward around a direction, where it presses against a neighbour. */
  dent(angle: number, amount: number): void {
    const t = ((((angle / TAU) % 1) + 1) % 1) * NODES;
    const i = Math.floor(t) % NODES;
    const f = t - Math.floor(t);
    const j = (i + 1) % NODES;
    const min = this.radius * 0.3;
    this.rs[i] = Math.max(min, this.rs[i] - amount * (1 - f));
    this.rs[j] = Math.max(min, this.rs[j] - amount * f);
  }

  /** Largest membrane radius, for cheap overlap rejection. */
  maxRadius(): number {
    let m = 0;
    for (let i = 0; i < NODES; i++) m = Math.max(m, this.rs[i]);
    return m;
  }

  /** Move the whole cell, used for gentle separation between neighbours. */
  translate(dx: number, dy: number): void {
    this.cx += dx;
    this.cy += dy;
    this.updateOutline();
  }

  /** Axis-aligned bounds of the membrane. */
  bounds(): { x0: number; y0: number; x1: number; y1: number } {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < NODES; i++) {
      x0 = Math.min(x0, this.xs[i]);
      x1 = Math.max(x1, this.xs[i]);
      y0 = Math.min(y0, this.ys[i]);
      y1 = Math.max(y1, this.ys[i]);
    }
    return { x0, y0, x1, y1 };
  }
}
