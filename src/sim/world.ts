import { Amoeba, NODES } from './amoeba';
import { Rng, clamp } from './rng';

/** A drifting particle of debris, mostly there to sell depth. */
export interface Speck {
  x: number;
  y: number;
  z: number;
  r: number;
  vx: number;
  vy: number;
  shade: number;
}

/** Clearance kept between neighbouring membranes, world px. */
const CONTACT_GAP = 3;

export class World {
  readonly rng: Rng;
  readonly cells: Amoeba[] = [];
  readonly specks: Speck[] = [];
  width: number;
  height: number;
  time = 0;
  /** Current depth of the focal plane, drifts slowly. */
  focus = 0;

  constructor(seed: number, width: number, height: number) {
    this.rng = new Rng(seed);
    this.width = width;
    this.height = height;
    this.populate();
  }

  private populate(): void {
    const { rng } = this;
    const unit = Math.min(this.width, this.height);
    const area = (this.width * this.height) / (unit * unit);
    const count = Math.round(clamp(3.5 * area, 3, 7));
    for (let i = 0; i < count; i++) {
      const radius = unit * rng.range(0.085, 0.14);
      let x = 0;
      let y = 0;
      for (let attempt = 0; attempt < 30; attempt++) {
        x = rng.range(radius * 2, this.width - radius * 2);
        y = rng.range(radius * 2, this.height - radius * 2);
        if (this.cells.every((c) => Math.hypot(c.cx - x, c.cy - y) > (c.radius + radius) * 1.6)) break;
      }
      this.cells.push(new Amoeba(rng, x, y, radius));
    }
    const specks = Math.round(45 * area);
    for (let i = 0; i < specks; i++) {
      this.specks.push({
        x: rng.range(0, this.width),
        y: rng.range(0, this.height),
        z: rng.range(-1.3, 1.3),
        r: unit * rng.range(0.0012, 0.0045) * (rng.next() < 0.08 ? 3 : 1),
        vx: rng.gauss() * 1.5,
        vy: rng.gauss() * 1.5,
        shade: rng.range(0.2, 1),
      });
    }
  }

  resize(width: number, height: number): void {
    const sx = width / this.width;
    const sy = height / this.height;
    for (const s of this.specks) {
      s.x *= sx;
      s.y *= sy;
    }
    this.width = width;
    this.height = height;
  }

  step(dt: number): void {
    this.time += dt;
    const t = this.time;
    this.focus = 0.35 * Math.sin(t * 0.021) + 0.15 * Math.sin(t * 0.053 + 1.3);

    const bounds = { w: this.width, h: this.height };
    for (const c of this.cells) c.step(dt, this.rng, bounds);
    this.separate();

    for (const s of this.specks) {
      // Brownian drift, plus a faint current.
      s.vx += this.rng.gauss() * 3 * dt - s.vx * 0.5 * dt;
      s.vy += this.rng.gauss() * 3 * dt - s.vy * 0.5 * dt;
      s.x += (s.vx + 0.6) * dt;
      s.y += (s.vy + 0.25) * dt;
      if (s.x < -20) s.x += this.width + 40;
      if (s.x > this.width + 20) s.x -= this.width + 40;
      if (s.y < -20) s.y += this.height + 40;
      if (s.y > this.height + 20) s.y -= this.height + 40;
    }
  }

  /**
   * The drop is a thin film under a cover slip, so cells share one plane and
   * cannot pass over each other. Where membranes press together they flatten
   * against each other, and the cells are nudged apart.
   */
  private separate(): void {
    const cells = this.cells;
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i];
        const b = cells[j];
        const reach = a.maxRadius() + b.maxRadius() + CONTACT_GAP;
        if (Math.abs(b.cx - a.cx) > reach || Math.abs(b.cy - a.cy) > reach) continue;
        const pa = this.press(a, b);
        const pb = this.press(b, a);
        if (pa + pb === 0) continue;
        const dx = b.cx - a.cx;
        const dy = b.cy - a.cy;
        const d = Math.hypot(dx, dy) || 1;
        const push = Math.min((pa + pb) * 0.04, 2);
        a.translate((-dx / d) * push, (-dy / d) * push);
        b.translate((dx / d) * push, (dy / d) * push);
      }
    }
  }

  /** Flatten `a` and `b` where `a`'s membrane pokes into `b`. Returns total overlap. */
  private press(a: Amoeba, b: Amoeba): number {
    let total = 0;
    for (let i = 0; i < NODES; i++) {
      const dx = a.xs[i] - b.cx;
      const dy = a.ys[i] - b.cy;
      const ang = Math.atan2(dy, dx);
      const pen = b.radiusAt(ang) + CONTACT_GAP - Math.hypot(dx, dy);
      if (pen <= 0) continue;
      a.dent((i / NODES) * Math.PI * 2, pen * 0.5);
      b.dent(ang, pen * 0.5);
      total += pen;
    }
    if (total > 0) {
      a.updateOutline();
      b.updateOutline();
    }
    return total;
  }

  /** Defocus blur radius (world px) for something at depth z. */
  blurAt(z: number): number {
    const dz = Math.abs(z - this.focus);
    return Math.min(this.width, this.height) * 0.0045 * Math.pow(dz, 1.3);
  }
}
