import { Amoeba } from './amoeba';
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

/** Depth difference below which two cells are in the same layer and collide. */
const SAME_LAYER = 0.35;

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
      const x = rng.range(radius * 2, this.width - radius * 2);
      const y = rng.range(radius * 2, this.height - radius * 2);
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
    this.separate(dt);

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

  /** Cells in the same depth layer nudge each other apart; others pass over and under. */
  private separate(dt: number): void {
    const cells = this.cells;
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = cells[i];
        const b = cells[j];
        if (Math.abs(a.z - b.z) > SAME_LAYER) continue;
        const dx = b.cx - a.cx;
        const dy = b.cy - a.cy;
        const d = Math.hypot(dx, dy) || 1;
        const overlap = (a.radius + b.radius) * 1.1 - d;
        if (overlap <= 0) continue;
        const push = Math.min(overlap, 30) * 0.6 * dt;
        a.translate((-dx / d) * push, (-dy / d) * push);
        b.translate((dx / d) * push, (dy / d) * push);
      }
    }
  }

  /** Defocus blur radius (world px) for something at depth z. */
  blurAt(z: number): number {
    const dz = Math.abs(z - this.focus);
    return Math.min(this.width, this.height) * 0.014 * Math.pow(dz, 1.4);
  }
}
