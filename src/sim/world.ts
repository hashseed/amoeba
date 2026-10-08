import { Cell, CellState, NODES, OrganelleKind, Species } from './cell';
import { Nutrients } from './nutrients';
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
/** Birth radius of each species, as a fraction of the shorter screen side. */
const BIRTH_SIZE: Record<Species, number> = {
  [Species.Amoeba]: 0.075,
  [Species.Alga]: 0.02,
};
/** Nutrient level the water drifts back toward, per grid cell (mass units). */
const NUTRIENT_FLOOR = 900;
/** Box modes of the water current: wave numbers, how fast each swings, and its phase. */
const CURRENT_MODES = [
  { m: 1, n: 1, speed: 0.011, phase: 0.3 },
  { m: 2, n: 1, speed: 0.017, phase: 2.1 },
  { m: 1, n: 2, speed: 0.013, phase: 4.0 },
  { m: 2, n: 2, speed: 0.023, phase: 1.2 },
  { m: 3, n: 2, speed: 0.019, phase: 5.1 },
  { m: 2, n: 3, speed: 0.029, phase: 3.3 },
];

export class World {
  readonly rng: Rng;
  readonly cells: Cell[] = [];
  readonly specks: Speck[] = [];
  width: number;
  height: number;
  time = 0;
  /** Current depth of the focal plane, drifts slowly. */
  focus = 0;
  /** Render everything in focus (debugging aid). */
  sharp = false;
  readonly nutrients: Nutrients;
  private readonly unit: number;
  private readonly caps: Record<Species, number>;
  private readonly baseSpecks: number;
  /** Running event tallies, for the debug overlay and tuning. */
  readonly stats = { divisions: 0, deaths: 0, meals: 0, immigrants: 0 };
  private huntTimer = 0;
  private spawnTimer = 0;

  constructor(seed: number, width: number, height: number) {
    this.rng = new Rng(seed);
    this.width = width;
    this.height = height;
    this.unit = Math.min(width, height);
    const area = (width * height) / (this.unit * this.unit);
    this.caps = {
      // Amoebae are limited by food rather than space; the cap only bounds the cost.
      [Species.Amoeba]: Math.round(clamp(3.5 * area, 3, 6)),
      [Species.Alga]: Math.round(30 * area),
    };
    this.baseSpecks = Math.round(45 * area);
    this.nutrients = new Nutrients(width, height, this.unit / 7, 4000);
    this.populate(area);
  }

  private birthRadius(species: Species): number {
    return BIRTH_SIZE[species] * this.unit;
  }

  private populate(area: number): void {
    const { rng } = this;
    const amoebae = Math.round(clamp(3 * area, 3, 6));
    for (let i = 0; i < amoebae; i++) this.place(Species.Amoeba, rng.range(1, 1.35));
    const algae = Math.round(20 * area);
    for (let i = 0; i < algae; i++) this.place(Species.Alga, rng.range(1, 1.35));

    for (let i = 0; i < this.baseSpecks; i++) {
      this.specks.push({
        x: rng.range(0, this.width),
        y: rng.range(0, this.height),
        z: rng.range(-1.3, 1.3),
        r: this.unit * rng.range(0.0012, 0.0045) * (rng.next() < 0.08 ? 3 : 1),
        vx: rng.gauss() * 1.5,
        vy: rng.gauss() * 1.5,
        shade: rng.range(0.2, 1),
      });
    }
  }

  /** Add a cell somewhere clear of the others. */
  private place(species: Species, scale: number): void {
    const { rng } = this;
    const birth = this.birthRadius(species);
    const radius = birth * scale;
    let x = 0;
    let y = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      x = rng.range(radius * 2, this.width - radius * 2);
      y = rng.range(radius * 2, this.height - radius * 2);
      if (this.cells.every((c) => Math.hypot(c.cx - x, c.cy - y) > (c.radius + radius) * 1.4)) break;
    }
    this.cells.push(new Cell(species, rng, x, y, radius, birth));
  }

  /** Bring a newcomer in from just beyond an edge, as if drifting into view. */
  private immigrate(species: Species): void {
    const { rng } = this;
    const birth = this.birthRadius(species);
    const radius = birth * rng.range(1, 1.3);
    const edge = rng.int(0, 4);
    const out = radius * 1.5;
    const x = edge === 0 ? -out : edge === 1 ? this.width + out : rng.range(0, this.width);
    const y = edge === 2 ? -out : edge === 3 ? this.height + out : rng.range(0, this.height);
    const cell = new Cell(species, rng, x, y, radius, birth);
    cell.heading = Math.atan2(this.height / 2 - y, this.width / 2 - x);
    this.cells.push(cell);
    this.stats.immigrants++;
  }

  resize(width: number, height: number): void {
    const sx = width / this.width;
    const sy = height / this.height;
    for (const s of this.specks) {
      s.x *= sx;
      s.y *= sy;
    }
    for (const c of this.cells) c.translate(c.cx * (sx - 1), c.cy * (sy - 1));
    this.width = width;
    this.height = height;
  }

  /** Live cells of a species; one that is dividing counts as the two it will become. */
  count(species: Species): number {
    let n = 0;
    for (const c of this.cells) {
      if (c.species !== species || !c.alive) continue;
      n += c.state === CellState.Dividing ? 2 : 1;
    }
    return n;
  }

  step(dt: number): void {
    this.time += dt;
    const t = this.time;
    this.focus = 0.35 * Math.sin(t * 0.021) + 0.15 * Math.sin(t * 0.053 + 1.3);

    const ctx = { rng: this.rng, bounds: { w: this.width, h: this.height }, nutrients: this.nutrients };
    for (const c of this.cells) {
      c.step(dt, ctx);
      if (c.expelled.length) this.egest(c);
    }
    this.nutrients.step(dt, NUTRIENT_FLOOR);
    // Passive drifters ride the slow currents in the drop, which keeps algal
    // blooms from settling into one corner.
    for (const c of this.cells) {
      if (c.species !== Species.Alga || c.capturedBy || !c.alive) continue;
      const f = this.current(c.cx, c.cy);
      c.translate(f.x * dt, f.y * dt);
    }

    this.hunt(dt);
    this.lifecycle();
    this.immigration(dt);
    this.separate();
    this.driftSpecks(dt);
  }

  /** Amoebae pick out nearby prey, crawl to it and start engulfing on contact. */
  private hunt(dt: number): void {
    this.huntTimer -= dt;
    const retarget = this.huntTimer <= 0;
    if (retarget) this.huntTimer = 0.5;

    for (const a of this.cells) {
      if (a.species !== Species.Amoeba || a.state !== CellState.Alive || a.prey || a.capturedBy) continue;
      if (retarget) a.target = this.hungry(a) ? this.choosePrey(a) : null;
      const prey = a.target;
      if (!prey) continue;
      if (prey.state !== CellState.Alive || prey.capturedBy) {
        a.target = null;
        continue;
      }
      const dx = prey.cx - a.cx;
      const dy = prey.cy - a.cy;
      const dist = Math.hypot(dx, dy);
      if (dist - prey.radius < a.radiusAt(Math.atan2(dy, dx)) + CONTACT_GAP + 2) {
        a.startEngulfing(prey);
        prey.z = a.z + 0.001;
      }
    }
  }

  /** A cell that is well fed, or still digesting a meal, doesn't hunt. */
  private hungry(a: Cell): boolean {
    // A full-grown cell that has no room to divide only eats to stay alive.
    const fullGrown = a.radius >= a.birthRadius * a.traits.divideAt;
    if (a.energy > a.mass * a.traits.reserve * (fullGrown ? 0.7 : 2.2)) return false;
    let digesting = 0;
    for (const o of a.organelles) if (o.kind === OrganelleKind.FoodVacuole) digesting += o.content;
    return digesting < a.mass * 0.18;
  }

  private choosePrey(a: Cell): Cell | null {
    let best: Cell | null = null;
    let bestScore = Infinity;
    const sense = a.radius * 2;
    for (const c of this.cells) {
      if (c === a || c.state !== CellState.Alive || c.capturedBy) continue;
      // Algae are always fair game; other amoebae only when much smaller.
      if (c.species === Species.Amoeba && c.radius > a.radius * 0.55) continue;
      const d = Math.hypot(c.cx - a.cx, c.cy - a.cy) - c.radius - a.radius;
      if (d > sense) continue;
      // Prefer close, large prey.
      const score = d / (c.radius + 1);
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  /** Division, starvation, and removal of cells that are finished. */
  private lifecycle(): void {
    const { rng } = this;
    const born: Cell[] = [];
    // Counted once up front: a dividing cell already counts as two.
    const counts = { [Species.Amoeba]: this.count(Species.Amoeba), [Species.Alga]: this.count(Species.Alga) };
    for (const c of this.cells) {
      if (c.capturedBy) continue;
      if (c.starved) {
        c.release();
        c.startDying();
        counts[c.species]--;
      } else if (c.wantsToDivide && counts[c.species] < this.caps[c.species]) {
        c.startDividing(rng);
        counts[c.species]++;
      } else if (c.divisionDone) {
        born.push(...c.split(rng));
        this.stats.divisions++;
      }
    }
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const c = this.cells[i];
      if (c.state !== CellState.Gone) continue;
      this.cells.splice(i, 1);
      // Whatever was still being digested inside goes with it.
      for (const o of c.organelles) {
        if (o.cell && o.cell.capturedBy === c) {
          o.cell.state = CellState.Gone;
          o.cell.capturedBy = null;
        }
      }
      if (c.visibility < 0.5) {
        this.decompose(c);
        this.stats.deaths++;
      } else if (c.eaten) {
        this.stats.meals++;
      }
    }
    this.cells.push(...born);
  }

  /** Residue pushed out of a cell becomes a speck of debris and slowly feeds the water. */
  private egest(c: Cell): void {
    for (const e of c.expelled) {
      this.nutrients.add(e.x, e.y, e.mass);
      this.specks.push({
        x: e.x,
        y: e.y,
        z: c.z,
        r: Math.max(e.r, this.unit * 0.002),
        vx: Math.cos(c.heading + Math.PI) * 2,
        vy: Math.sin(c.heading + Math.PI) * 2,
        shade: 0.9,
      });
    }
    c.expelled.length = 0;
    this.trimSpecks();
  }

  private trimSpecks(): void {
    // Old debris settles out of view so it never piles up.
    const max = Math.round(this.baseSpecks * 1.5);
    if (this.specks.length > max) this.specks.splice(0, this.specks.length - max);
  }

  /** A dead cell returns its matter to the water and leaves a little debris. */
  private decompose(c: Cell): void {
    let left = c.mass + c.energy;
    for (const o of c.organelles) left += o.content;
    this.nutrients.add(c.cx, c.cy, left);
    const { rng } = this;
    const bits = rng.int(2, 5);
    for (let i = 0; i < bits; i++) {
      this.specks.push({
        x: c.cx + rng.gauss() * c.radius * 0.4,
        y: c.cy + rng.gauss() * c.radius * 0.4,
        z: c.z + rng.gauss() * 0.2,
        r: this.unit * rng.range(0.0015, 0.004),
        vx: rng.gauss() * 1.5,
        vy: rng.gauss() * 1.5,
        shade: rng.range(0.4, 1),
      });
    }
    this.trimSpecks();
  }

  /** Keep the drop from ever emptying: newcomers drift in when a species runs low. */
  private immigration(dt: number): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = 4;
    if (this.count(Species.Amoeba) < 2) this.immigrate(Species.Amoeba);
    if (this.count(Species.Alga) < 4) this.immigrate(Species.Alga);
  }

  /**
   * A slow, divergence-free current that never runs into the edges of the drop.
   * It is a sum of a few box modes of a stream function, ψ = Σ aₖ(t)·sin(mπx/W)·sin(nπy/H),
   * which is zero along every edge, so water only ever flows along the walls,
   * never into them. Each mode's strength swings slowly between positive and
   * negative, so eddies grow, fade and reverse over minutes and nothing settles
   * in one place for long.
   */
  current(x: number, y: number): { x: number; y: number } {
    const t = this.time;
    const W = this.width;
    const H = this.height;
    const amp = this.unit * 0.016;
    let u = 0;
    let v = 0;
    for (const m of CURRENT_MODES) {
      const a = amp * Math.sin(t * m.speed + m.phase);
      const kx = (m.m * Math.PI) / W;
      const ky = (m.n * Math.PI) / H;
      // Normalised so every mode moves water at about the same peak speed.
      const c = a / Math.hypot(kx, ky);
      u += c * ky * Math.sin(kx * x) * Math.cos(ky * y);
      v -= c * kx * Math.cos(kx * x) * Math.sin(ky * y);
    }
    return { x: u, y: v };
  }

  private driftSpecks(dt: number): void {
    for (const s of this.specks) {
      // Brownian drift, carried along by the current.
      const f = this.current(s.x, s.y);
      s.vx += this.rng.gauss() * 3 * dt - s.vx * 0.5 * dt;
      s.vy += this.rng.gauss() * 3 * dt - s.vy * 0.5 * dt;
      s.x += (s.vx + f.x) * dt;
      s.y += (s.vy + f.y) * dt;
      if (s.x < -20) s.x += this.width + 40;
      if (s.x > this.width + 20) s.x -= this.width + 40;
      if (s.y < -20) s.y += this.height + 40;
      if (s.y > this.height + 20) s.y -= this.height + 40;
    }
  }

  /**
   * The drop is a thin film under a cover slip, so cells share one plane and
   * cannot pass over each other. Where membranes press together they flatten
   * against each other, and the cells are nudged apart (the lighter one more).
   */
  private separate(): void {
    const cells = this.cells;
    for (let i = 0; i < cells.length; i++) {
      const a = cells[i];
      if (!this.solid(a)) continue;
      for (let j = i + 1; j < cells.length; j++) {
        const b = cells[j];
        if (!this.solid(b) || a.prey === b || b.prey === a) continue;
        const reach = a.maxRadius() + b.maxRadius() + CONTACT_GAP;
        if (Math.abs(b.cx - a.cx) > reach || Math.abs(b.cy - a.cy) > reach) continue;
        const pa = this.press(a, b);
        const pb = this.press(b, a);
        if (pa + pb === 0) continue;
        const dx = b.cx - a.cx;
        const dy = b.cy - a.cy;
        const d = Math.hypot(dx, dy) || 1;
        const push = Math.min((pa + pb) * 0.04, 2);
        const wa = b.mass / (a.mass + b.mass);
        a.translate((-dx / d) * push * 2 * wa, (-dy / d) * push * 2 * wa);
        b.translate((dx / d) * push * 2 * (1 - wa), (dy / d) * push * 2 * (1 - wa));
      }
    }
  }

  private solid(c: Cell): boolean {
    return !c.capturedBy && (c.state === CellState.Alive || c.state === CellState.Dividing);
  }

  /** Flatten `a` and `b` where `a`'s membrane pokes into `b`. Returns total overlap. */
  private press(a: Cell, b: Cell): number {
    let total = 0;
    const wa = b.mass / (a.mass + b.mass);
    const reach = b.maxRadius() + CONTACT_GAP;
    for (let i = 0; i < NODES; i++) {
      const dx = a.xs[i] - b.cx;
      const dy = a.ys[i] - b.cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > reach * reach) continue;
      const ang = Math.atan2(dy, dx);
      const pen = b.radiusAt(ang) + CONTACT_GAP - Math.sqrt(d2);
      if (pen <= 0) continue;
      // The softer, lighter cell gives way more.
      a.dent((i / NODES) * Math.PI * 2, pen * wa);
      b.dent(ang, pen * (1 - wa));
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
    if (this.sharp) return 0;
    const dz = Math.abs(z - this.focus);
    return this.unit * 0.0045 * Math.pow(dz, 1.3);
  }
}
