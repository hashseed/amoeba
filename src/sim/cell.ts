import { algaTint, amoebaTint, chloroplastTint, foodTint, randomAlgaTint, randomTint, type CellTint, type Rgb } from '../palette';
import type { Nutrients } from './nutrients';
import { angleDiff, clamp, noise1, type Rng } from './rng';

export const enum OrganelleKind {
  Nucleus = 0,
  ContractileVacuole = 1,
  FoodVacuole = 2,
  Droplet = 3,
  Chloroplast = 4,
}

export interface Organelle {
  kind: OrganelleKind;
  /** Offset from the cell centre, in world px. */
  ox: number;
  oy: number;
  /** Resting offset as a fraction of the cell radius. */
  rx: number;
  ry: number;
  /** Current radius, px. */
  r: number;
  /** Radius as a fraction of the cell radius. */
  size: number;
  /** Free-running phase for pulsing and wobble. */
  phase: number;
  /** Fixed orientation, radians (used by chloroplasts). */
  orient: number;
  tint: Rgb;
  /** Food vacuoles: undigested mass left inside. */
  content: number;
}

interface Pseudopod {
  angle: number;
  /** Angular half-width of the bulge, radians. */
  width: number;
  power: number;
  age: number;
  life: number;
}

export const enum Species {
  Amoeba = 0,
  Alga = 1,
}

export const enum CellState {
  Alive = 0,
  Dividing = 1,
  Dying = 2,
  /** Finished: eaten or dissolved, to be removed from the world. */
  Gone = 3,
}

interface SpeciesTraits {
  motile: boolean;
  /** Second- and fourth-order smoothing of r(θ) (surface tension). */
  smooth2: number;
  smooth4: number;
  undulation: number;
  /** Membrane resists being pulled in below this fraction of R. */
  floor: number;
  /** Cell wall strength for rendering (algae have one, amoebae don't). */
  wall: number;
  /** Energy burned per second, as a fraction of mass. */
  metabolism: number;
  /** Energy kept in reserve before any goes into growth, fraction of mass. */
  reserve: number;
  /** Fastest growth, fraction of mass per second. */
  growth: number;
  /** Energy fixed from light per second, fraction of mass, when nutrients are plentiful. */
  photosynthesis: number;
  /** Divide once the radius reaches this multiple of the birth radius. */
  divideAt: number;
  divideSeconds: number;
  /** Starve to death below this multiple of the birth radius. */
  dieBelow: number;
  dieSeconds: number;
}

const TRAITS: Record<Species, SpeciesTraits> = {
  [Species.Amoeba]: {
    motile: true,
    smooth2: 0.5,
    smooth4: 0.1,
    undulation: 0.025,
    floor: 0.8,
    wall: 0,
    metabolism: 0.002,
    reserve: 0.45,
    growth: 0.01,
    photosynthesis: 0,
    divideAt: 1.42,
    divideSeconds: 14,
    dieBelow: 0.85,
    dieSeconds: 10,
  },
  [Species.Alga]: {
    motile: false,
    smooth2: 1.6,
    smooth4: 0.25,
    undulation: 0.008,
    floor: 0.92,
    wall: 1,
    metabolism: 0.0012,
    reserve: 0.25,
    growth: 0.012,
    photosynthesis: 0.02,
    divideAt: 1.42,
    divideSeconds: 8,
    dieBelow: 0.75,
    dieSeconds: 6,
  },
};

/** Number of membrane samples around the cell. */
export const NODES = 48;
/** Hard cap so the renderer's data texture row always fits. */
export const MAX_ORGANELLES = 16;
/** Half-saturation constant for nutrient uptake, in mass units per grid cell. */
const NUTRIENT_K = 1500;

const TAU = Math.PI * 2;
/** Unit directions of the membrane samples. */
const COS = Float32Array.from({ length: NODES }, (_, i) => Math.cos((i / NODES) * TAU));
const SIN = Float32Array.from({ length: NODES }, (_, i) => Math.sin((i / NODES) * TAU));
/** cos/sin of k·θ for the low-frequency undulation harmonics k = 2, 3, 4. */
const HARMONICS = [2, 3, 4].map((k) => ({
  cos: Float32Array.from({ length: NODES }, (_, i) => Math.cos((k * i * TAU) / NODES)),
  sin: Float32Array.from({ length: NODES }, (_, i) => Math.sin((k * i * TAU) / NODES)),
}));

export interface StepContext {
  rng: Rng;
  bounds: { w: number; h: number };
  nutrients: Nutrients;
}

/**
 * A single cell whose membrane is a radius function r(θ) sampled around a
 * moving centre. The cell lives in a viscous medium, so motion is overdamped
 * and calm. Pseudopods are bulges in r(θ); the centre then flows toward them
 * while the membrane stays put, so the body visibly catches up with each
 * pseudopod. A star-shaped outline can never tangle, however forces add up.
 *
 * Each cell also carries a small energy budget: it eats (or photosynthesises),
 * burns energy to stay alive, grows when it has a surplus, divides when large
 * enough, and dissolves when it starves.
 */
export class Cell {
  readonly species: Species;
  readonly traits: SpeciesTraits;
  readonly xs = new Float32Array(NODES);
  readonly ys = new Float32Array(NODES);
  /** Membrane radius at angle i·2π/NODES around (cx, cy). */
  private readonly rs = new Float32Array(NODES);
  private readonly dr = new Float32Array(NODES);
  private maxR = 0;
  private readonly share = new Float32Array(NODES);

  cx: number;
  cy: number;
  /** Rest radius; the target area is that of a circle of this radius. */
  radius: number;
  /** Radius at birth for this species and screen, the yardstick for growth. */
  readonly birthRadius: number;
  heading: number;
  /** Height within the film, roughly -1 to 1; only affects focus. */
  z: number;
  private zTarget: number;
  private zTimer = 0;

  energy: number;
  state = CellState.Alive;
  /** Seconds into dividing or dying. */
  private stateTime = 0;
  private divideAxis = 0;
  private nucleusSplit = false;
  /** 0..1, how much of the cell is still visible (fades while dissolving). */
  visibility = 1;

  /** Prey the cell is hunting. */
  target: Cell | null = null;
  /** Prey currently being engulfed. */
  prey: Cell | null = null;
  private engulfTime = 0;
  /** Set once this cell has ended up in someone's food vacuole. */
  eaten = false;
  /** Set on prey while it is being engulfed. */
  capturedBy: Cell | null = null;

  readonly tint: CellTint;
  readonly seed: number;
  readonly organelles: Organelle[] = [];
  private readonly pods: Pseudopod[] = [];
  private podTimer = 0;
  private time = 0;

  constructor(
    species: Species,
    rng: Rng,
    x: number,
    y: number,
    radius: number,
    birthRadius: number,
    tint?: CellTint,
    organelles = true,
  ) {
    this.species = species;
    this.traits = TRAITS[species];
    this.cx = x;
    this.cy = y;
    this.radius = radius;
    this.birthRadius = birthRadius;
    this.seed = rng.int(1, 1 << 30);
    this.heading = rng.range(0, TAU);
    this.z = rng.range(-1, 1);
    this.zTarget = this.z;
    this.tint = tint ?? (species === Species.Amoeba ? randomTint(rng) : randomAlgaTint(rng));
    this.energy = this.mass * this.traits.reserve;
    for (let i = 0; i < NODES; i++) {
      this.rs[i] = radius * (1 + this.traits.undulation * 3 * Math.sin((i / NODES) * TAU * 3 + this.seed));
    }
    this.updateOutline();
    if (organelles) this.spawnOrganelles(rng);
  }

  get mass(): number {
    return Math.PI * this.radius * this.radius;
  }

  get alive(): boolean {
    return this.state === CellState.Alive || this.state === CellState.Dividing;
  }

  private addOrganelle(rng: Rng, kind: OrganelleKind, size: number, spread: number, tint: Rgb, content = 0): Organelle {
    const a = rng.range(0, TAU);
    const d = Math.sqrt(rng.next()) * spread;
    const o: Organelle = {
      kind,
      ox: Math.cos(a) * d * this.radius,
      oy: Math.sin(a) * d * this.radius,
      rx: Math.cos(a) * d,
      ry: Math.sin(a) * d,
      r: size * this.radius,
      size,
      phase: rng.range(0, 10),
      orient: rng.range(0, TAU),
      tint,
      content,
    };
    this.organelles.push(o);
    return o;
  }

  private spawnOrganelles(rng: Rng): void {
    const ink = this.tint.ink;
    if (this.species === Species.Amoeba) {
      this.addOrganelle(rng, OrganelleKind.Nucleus, rng.range(0.2, 0.25), 0.15, ink);
      const cvs = rng.int(1, 3);
      for (let i = 0; i < cvs; i++) this.addOrganelle(rng, OrganelleKind.ContractileVacuole, rng.range(0.1, 0.14), 0.6, ink);
      const foods = rng.int(1, 3);
      for (let i = 0; i < foods; i++) {
        const f = this.addOrganelle(rng, OrganelleKind.FoodVacuole, 0.1, 0.6, foodTint(rng), this.mass * 0.03);
        f.size = this.vacuoleSize(f.content);
      }
      const drops = rng.int(4, 8);
      for (let i = 0; i < drops; i++) this.addOrganelle(rng, OrganelleKind.Droplet, rng.range(0.025, 0.045), 0.7, ink);
    } else {
      const chloro = this.addOrganelle(rng, OrganelleKind.Chloroplast, 0.62, 0.05, chloroplastTint(this.tint.hue));
      const away = chloro.orient + Math.PI;
      const nucleus = this.addOrganelle(rng, OrganelleKind.Nucleus, 0.24, 0, ink);
      nucleus.rx = Math.cos(away) * 0.35;
      nucleus.ry = Math.sin(away) * 0.35;
      const drops = rng.int(1, 4);
      for (let i = 0; i < drops; i++) this.addOrganelle(rng, OrganelleKind.Droplet, rng.range(0.06, 0.1), 0.45, ink);
    }
  }

  /** Food vacuole radius (fraction of cell radius) for a given content mass. */
  private vacuoleSize(content: number): number {
    return clamp(Math.sqrt(content / Math.PI) / this.radius + 0.03, 0.05, 0.4);
  }

  step(dt: number, ctx: StepContext): void {
    this.time += dt;
    this.updateDepth(dt, ctx.rng);
    if (this.capturedBy) {
      // Being engulfed: held still while the predator wraps around it.
      this.updateOrganelles(dt);
      return;
    }
    if (this.state === CellState.Dying) {
      this.dissolve(dt);
      return;
    }
    this.metabolise(dt, ctx.nutrients);
    if (this.state === CellState.Dividing) {
      this.divide(dt);
    } else {
      if (this.traits.motile) {
        this.updatePods(dt, ctx.rng);
        this.steer(dt, ctx.bounds);
      } else {
        this.drift(dt, ctx.bounds);
      }
      this.reshape(dt);
      if (this.traits.motile) this.crawl(dt);
      if (this.prey) this.engulf(dt);
    }
    this.updateOutline();
    this.updateOrganelles(dt);
  }

  // --- Physiology ---------------------------------------------------------

  private metabolise(dt: number, nutrients: Nutrients): void {
    const t = this.traits;
    const mass = this.mass;
    const burn = t.metabolism * mass * dt;
    this.energy -= burn;
    // Respiration returns the burned matter to the water.
    nutrients.add(this.cx, this.cy, burn);

    if (t.photosynthesis > 0) {
      const level = nutrients.level(this.cx, this.cy);
      const want = t.photosynthesis * mass * dt * (level / (level + NUTRIENT_K));
      this.energy += nutrients.take(this.cx, this.cy, want);
    }

    // Digest food vacuoles: they shrink as their content becomes energy.
    for (let i = this.organelles.length - 1; i >= 0; i--) {
      const o = this.organelles[i];
      if (o.kind !== OrganelleKind.FoodVacuole) continue;
      const digested = Math.min(o.content, (o.content * 0.02 + mass * 0.0002) * dt);
      o.content -= digested;
      this.energy += digested * 0.8;
      nutrients.add(this.cx, this.cy, digested * 0.2);
      o.size = this.vacuoleSize(o.content);
      if (o.content <= 0.5) this.organelles.splice(i, 1);
    }

    if (this.state !== CellState.Alive) return;

    const reserve = t.reserve * mass;
    if (this.radius >= this.birthRadius * t.divideAt * 1.12) {
      // Full grown but not dividing (the drop is crowded): stop growing and
      // excrete what can't be stored.
      if (this.energy > reserve * 2) {
        nutrients.add(this.cx, this.cy, this.energy - reserve * 2);
        this.energy = reserve * 2;
      }
    } else if (this.energy > reserve) {
      // Surplus becomes new cytoplasm.
      const grow = Math.min(this.energy - reserve, t.growth * mass * dt);
      this.energy -= grow;
      this.setMass(mass + grow);
    } else if (this.energy < 0) {
      // Starving: the cell consumes itself.
      this.setMass(Math.max(1, mass + this.energy));
      this.energy = 0;
    }
  }

  private setMass(mass: number): void {
    this.radius = Math.sqrt(mass / Math.PI);
  }

  /** Ready to divide (the world decides whether there is room). */
  get wantsToDivide(): boolean {
    return (
      this.state === CellState.Alive &&
      !this.prey &&
      !this.capturedBy &&
      this.radius >= this.birthRadius * this.traits.divideAt &&
      this.energy >= this.mass * this.traits.reserve * 0.5
    );
  }

  get starved(): boolean {
    return this.state === CellState.Alive && this.radius < this.birthRadius * this.traits.dieBelow;
  }

  startDividing(rng: Rng): void {
    this.state = CellState.Dividing;
    this.stateTime = 0;
    this.divideAxis = this.traits.motile ? this.heading + rng.gauss() * 0.4 : rng.range(0, TAU);
    this.nucleusSplit = false;
    this.pods.length = 0;
    this.target = null;
  }

  get divisionDone(): boolean {
    return this.state === CellState.Dividing && this.stateTime >= this.traits.divideSeconds;
  }

  /** Daughter radius, separation of the two lobes, and lobe radius at division progress p. */
  private divisionShape(p: number): { d: number; rho: number } {
    const rc = this.radius / Math.SQRT2;
    const s = smoothstep(0.15, 1, p);
    return { d: s * rc * 0.92, rho: this.radius + (rc - this.radius) * s };
  }

  /**
   * Mitosis: the nucleus splits, the cell stretches along the division axis
   * and pinches in at the waist until it is two lobes about to separate.
   */
  private divide(dt: number): void {
    this.stateTime += dt;
    const p = Math.min(1, this.stateTime / this.traits.divideSeconds);
    const { d, rho } = this.divisionShape(p);
    const ax = Math.cos(this.divideAxis);
    const ay = Math.sin(this.divideAxis);
    const k = Math.min(1, dt * 2.5);
    for (let i = 0; i < NODES; i++) {
      const ux = COS[i];
      const uy = SIN[i];
      // Far intersection of this ray with either lobe circle (centres ±d along the axis).
      const along = ux * ax + uy * ay;
      const reach = (c: number) => c * along + Math.sqrt(Math.max(0, c * c * along * along - c * c + rho * rho));
      const target = Math.max(reach(d), reach(-d));
      this.rs[i] += (target - this.rs[i]) * k;
    }

    if (!this.nucleusSplit && p > 0.2) {
      this.nucleusSplit = true;
      const n = this.organelles.find((o) => o.kind === OrganelleKind.Nucleus);
      if (n && this.organelles.length < MAX_ORGANELLES) {
        const twin = { ...n };
        n.size *= 0.85;
        twin.size = n.size;
        this.organelles.push(twin);
        // Send the two nuclei to opposite lobes.
        n.ox += ax * 2;
        n.oy += ay * 2;
        twin.ox -= ax * 2;
        twin.oy -= ay * 2;
      }
    }
    // Organelles gather into the lobe on their side, keeping their spread.
    const k2 = Math.min(1, dt * 0.4);
    for (const o of this.organelles) {
      const side = o.ox * ax + o.oy * ay >= 0 ? 1 : -1;
      const tx = ax * side * d + o.rx * rho * 0.6;
      const ty = ay * side * d + o.ry * rho * 0.6;
      o.ox += (tx - o.ox) * k2;
      o.oy += (ty - o.oy) * k2;
    }
  }

  /** Split into two daughter cells, one per lobe. */
  split(rng: Rng): [Cell, Cell] {
    const { d } = this.divisionShape(1);
    const ax = Math.cos(this.divideAxis);
    const ay = Math.sin(this.divideAxis);
    const rc = this.radius / Math.SQRT2;
    const make = (side: number) => {
      const hue = this.tint.hue + rng.gauss() * 5;
      const tint = this.species === Species.Amoeba ? amoebaTint(hue, this.tint.glowShift) : algaTint(hue, this.tint.glowShift);
      const child = new Cell(this.species, rng, this.cx + ax * d * side, this.cy + ay * d * side, rc, this.birthRadius, tint, false);
      child.energy = this.energy / 2;
      child.z = this.z;
      child.heading = this.divideAxis + (side > 0 ? 0 : Math.PI);
      // Each lobe is already close to a circle of this radius, so the split is seamless.
      for (let i = 0; i < NODES; i++) child.rs[i] = rc * (1 + rng.gauss() * 0.01);
      child.updateOutline();
      return child;
    };
    const a = make(1);
    const b = make(-1);
    for (const o of this.organelles) {
      const side = o.ox * ax + o.oy * ay >= 0 ? 1 : -1;
      const child = side > 0 ? a : b;
      if (child.organelles.length >= MAX_ORGANELLES) continue;
      const ox = o.ox - ax * d * side;
      const oy = o.oy - ay * d * side;
      const restScale = 0.7;
      child.organelles.push({
        ...o,
        ox,
        oy,
        rx: (ox / rc) * restScale,
        ry: (oy / rc) * restScale,
        size: o.kind === OrganelleKind.Nucleus || o.kind === OrganelleKind.Chloroplast ? o.size / 0.85 : o.size,
      });
    }
    // Every daughter needs a nucleus (and every alga a chloroplast).
    for (const child of [a, b]) {
      if (!child.organelles.some((o) => o.kind === OrganelleKind.Nucleus)) {
        child.addOrganelle(rng, OrganelleKind.Nucleus, child.species === Species.Amoeba ? 0.22 : 0.24, 0.1, child.tint.ink);
      }
      if (child.species === Species.Alga && !child.organelles.some((o) => o.kind === OrganelleKind.Chloroplast)) {
        child.addOrganelle(rng, OrganelleKind.Chloroplast, 0.62, 0.05, chloroplastTint(child.tint.hue));
      }
      if (child.species === Species.Amoeba && !child.organelles.some((o) => o.kind === OrganelleKind.ContractileVacuole)) {
        child.addOrganelle(rng, OrganelleKind.ContractileVacuole, 0.12, 0.6, child.tint.ink);
      }
    }
    this.state = CellState.Gone;
    return [a, b];
  }

  startDying(): void {
    if (this.state === CellState.Dying || this.state === CellState.Gone) return;
    this.state = CellState.Dying;
    this.stateTime = 0;
    this.pods.length = 0;
    this.prey = null;
    this.target = null;
  }

  /** The membrane slackens and the cell fades into the water. */
  private dissolve(dt: number): void {
    this.stateTime += dt;
    const p = this.stateTime / this.traits.dieSeconds;
    this.visibility = 1 - smoothstep(0.1, 1, p);
    for (let i = 0; i < NODES; i++) {
      const ang = (i / NODES) * TAU;
      this.rs[i] += this.radius * dt * (0.012 + 0.03 * noise1(ang * 2 + this.time * 0.3, this.seed));
    }
    this.updateOutline();
    for (const o of this.organelles) {
      o.phase += dt;
      // Contents drift apart as the membrane gives way.
      o.ox *= 1 + dt * 0.03;
      o.oy *= 1 + dt * 0.03;
    }
    if (p >= 1) this.state = CellState.Gone;
  }

  // --- Predation ------------------------------------------------------------

  /** Begin wrapping the membrane around prey that has been touched. */
  startEngulfing(prey: Cell): void {
    this.prey = prey;
    this.target = null;
    this.engulfTime = 0;
    prey.release();
    prey.target = null;
    prey.capturedBy = this;
    prey.pods.length = 0;
  }

  /** Let go of prey (when this cell dies or divides). */
  release(): void {
    if (this.prey) this.prey.capturedBy = null;
    this.prey = null;
  }

  /**
   * Phagocytosis: pseudopods flow around the prey and close over it, then the
   * prey is drawn inward and sealed into a food vacuole.
   */
  private engulf(dt: number): void {
    const prey = this.prey!;
    this.engulfTime += dt;
    const dx = prey.cx - this.cx;
    const dy = prey.cy - this.cy;
    const dist = Math.hypot(dx, dy) || 1;
    const ang = Math.atan2(dy, dx);
    const halfWidth = Math.asin(Math.min(1, (prey.radius * 1.3) / dist)) + 0.2;
    const wrap = smoothstep(0, 3, this.engulfTime);
    for (let i = 0; i < NODES; i++) {
      const a = angleDiff((i / NODES) * TAU, ang);
      if (Math.abs(a) > halfWidth) continue;
      const fall = 1 - Math.abs(a) / halfWidth;
      const want = (dist * Math.cos(a) + prey.radius * 1.25 + 4) * wrap;
      if (this.rs[i] < want) this.rs[i] += (want - this.rs[i]) * Math.min(1, dt * 2.5 * fall);
    }
    // Draw the prey in once it is enclosed.
    if (this.engulfTime > 2) {
      const pull = Math.min(dist, this.radius * 0.12 * dt);
      prey.cx -= (dx / dist) * pull;
      prey.cy -= (dy / dist) * pull;
      prey.updateOutline();
    }
    const inside = dist + prey.radius < this.radiusAt(ang) - 3;
    if (inside && this.engulfTime > 4) this.ingest(prey, dx, dy);
  }

  private ingest(prey: Cell, dx: number, dy: number): void {
    const content = prey.mass + prey.energy;
    if (this.organelles.length >= MAX_ORGANELLES) {
      const drop = this.organelles.findIndex((o) => o.kind === OrganelleKind.Droplet);
      if (drop >= 0) this.organelles.splice(drop, 1);
    }
    if (this.organelles.length < MAX_ORGANELLES) {
      const vac: Organelle = {
        kind: OrganelleKind.FoodVacuole,
        ox: dx,
        oy: dy,
        rx: (dx / this.radius) * 0.5,
        ry: (dy / this.radius) * 0.5,
        r: prey.radius,
        size: prey.radius / this.radius,
        phase: 0,
        orient: 0,
        tint: prey.species === Species.Alga ? chloroplastTint(prey.tint.hue) : prey.tint.body,
        content,
      };
      this.organelles.push(vac);
    } else {
      this.energy += content * 0.8;
    }
    prey.state = CellState.Gone;
    prey.eaten = true;
    prey.capturedBy = null;
    this.prey = null;
  }

  // --- Movement -------------------------------------------------------------

  /** Cells drift slowly up and down within the film, in and out of focus. */
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
    const hunting = this.target !== null;
    if (this.podTimer <= 0 && this.pods.length < 4 && !this.prey) {
      this.podTimer = hunting ? rng.range(1, 2.5) : rng.range(1.5, 4);
      const toward = hunting ? Math.atan2(this.target!.cy - this.cy, this.target!.cx - this.cx) : this.heading;
      const branch = !hunting && rng.next() < 0.35;
      this.pods.push({
        angle: toward + rng.gauss() * (branch ? 0.9 : hunting ? 0.2 : 0.4),
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

  /** Heading wanders, follows the strongest pseudopod or prey, and avoids the walls. */
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
    if (this.target) {
      turn += angleDiff(Math.atan2(this.target.cy - this.cy, this.target.cx - this.cx), this.heading) * 0.5;
    } else {
      turn += noise1(this.time * 0.07, this.seed) * 0.15;
    }
    const wall = wallAvoidance(this.cx, this.cy, this.radius * 2, bounds);
    if (wall.strength > 0) turn += angleDiff(wall.angle, this.heading) * wall.strength * 0.8;
    this.heading += turn * dt;
  }

  /** Non-motile cells just drift on faint currents and Brownian jostling. */
  private drift(dt: number, bounds: { w: number; h: number }): void {
    const s = this.birthRadius * 0.3;
    let vx = noise1(this.time * 0.03, this.seed) * s;
    let vy = noise1(this.time * 0.03 + 100, this.seed) * s;
    const wall = wallAvoidance(this.cx, this.cy, this.radius * 2, bounds);
    vx += Math.cos(wall.angle) * wall.strength * s * 2;
    vy += Math.sin(wall.angle) * wall.strength * s * 2;
    this.cx += vx * dt;
    this.cy += vy * dt;
  }

  /** Evolve r(θ): pseudopods push out, surface tension smooths, pressure keeps the area. */
  private reshape(dt: number): void {
    const { rs, dr } = this;
    const t = this.traits;
    const R = this.radius;
    let area = 0;
    for (let i = 0; i < NODES; i++) area += rs[i] * rs[i];
    area *= Math.PI / NODES;
    const targetArea = Math.PI * R * R;
    const pressure = ((targetArea - area) / targetArea) * R * 1.5;

    // Excess area (from a growing pseudopod) is drawn mostly from the rear, as
    // the trailing uroid retracts; a deficit inflates the cell evenly.
    const share = this.share;
    if (pressure < 0 && t.motile) {
      const hx = Math.cos(this.heading);
      const hy = Math.sin(this.heading);
      let sum = 0;
      for (let i = 0; i < NODES; i++) sum += share[i] = 0.25 + Math.max(0, -(COS[i] * hx + SIN[i] * hy)) * 1.75;
      for (let i = 0; i < NODES; i++) share[i] *= (NODES / sum) * pressure;
    } else {
      share.fill(pressure);
    }

    // Slow low-frequency undulation so the outline is never a perfect circle:
    // sin(kθ + φ) expanded so the per-node work is table lookups.
    const und = R * t.undulation;
    const uc = [0, 0, 0];
    const us = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const ph = noise1(this.time * 0.05, this.seed + k + 2) * 6;
      uc[k] = und * Math.cos(ph);
      us[k] = und * Math.sin(ph);
    }

    // Pseudopod bulges, as a von Mises bump around each pod direction.
    const pods = this.pods;
    const podX: number[] = [];
    const podY: number[] = [];
    const podK: number[] = [];
    const podA: number[] = [];
    for (const p of pods) {
      podX.push(Math.cos(p.angle));
      podY.push(Math.sin(p.angle));
      podK.push(2 / (p.width * p.width));
      podA.push(this.podEnvelope(p) * p.power);
    }

    const floor = R * t.floor;
    const roundness = t.motile ? 0.03 : 0.4;
    for (let i = 0; i < NODES; i++) {
      const r0 = rs[(i + NODES - 2) % NODES];
      const r1 = rs[(i + NODES - 1) % NODES];
      const r2 = rs[i];
      const r3 = rs[(i + 1) % NODES];
      const r4 = rs[(i + 2) % NODES];
      // Second- and fourth-order smoothing: rounds tips without flattening lobes.
      let d = (r1 + r3 - 2 * r2) * t.smooth2 - (r0 - 4 * r1 + 6 * r2 - 4 * r3 + r4) * t.smooth4;
      d += share[i];
      // The body stays plump: the membrane resists being pulled in too far.
      if (r2 < floor) d += (floor - r2) * 1.2;
      for (let k = 0; k < 3; k++) d += HARMONICS[k].sin[i] * uc[k] + HARMONICS[k].cos[i] * us[k];
      for (let p = 0; p < podA.length; p++) {
        d += Math.exp((COS[i] * podX[p] + SIN[i] * podY[p] - 1) * podK[p]) * podA[p];
      }
      // Gentle pull back toward a round cell keeps arms from growing without end.
      d += (R - r2) * roundness;
      dr[i] = d;
    }
    for (let i = 0; i < NODES; i++) rs[i] = Math.max(R * 0.3, rs[i] + dr[i] * dt);
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
    const speed = this.radius * (this.target ? 0.13 : 0.09);
    this.shiftCentre(vx * speed * dt, vy * speed * dt);
  }

  /** Move the centre without moving the membrane, by re-expressing r(θ). */
  private shiftCentre(dx: number, dy: number): void {
    for (let i = 0; i < NODES; i++) {
      this.rs[i] = Math.max(this.radius * 0.3, this.rs[i] - (COS[i] * dx + SIN[i] * dy));
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
    let m = 0;
    for (let i = 0; i < NODES; i++) {
      const r = this.rs[i];
      this.xs[i] = this.cx + COS[i] * r;
      this.ys[i] = this.cy + SIN[i] * r;
      if (r > m) m = r;
    }
    this.maxR = m;
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
    const dividing = this.state === CellState.Dividing;
    const jiggle = this.traits.motile ? 0.05 : 0.015;
    const orgs = this.organelles;
    for (let i = 0; i < orgs.length; i++) {
      const o = orgs[i];
      o.phase += dt;
      o.r = o.size * R;
      let vx = 0;
      let vy = 0;
      if (!dividing) {
        const stream = o.kind === OrganelleKind.Nucleus ? 0.01 : 0.025;
        vx += (o.rx * R - o.ox) * 0.25 + sx * stream * R;
        vy += (o.ry * R - o.oy) * 0.25 + sy * stream * R;
      }
      vx += noise1(o.phase * 0.3, this.seed + i * 17) * jiggle * R;
      vy += noise1(o.phase * 0.3 + 50, this.seed + i * 17) * jiggle * R;

      // Organelles jostle rather than overlap (the chloroplast is a backdrop).
      if (o.kind !== OrganelleKind.Chloroplast) {
        for (let j = 0; j < orgs.length; j++) {
          const q = orgs[j];
          if (j === i || q.kind === OrganelleKind.Chloroplast) continue;
          const dx = o.ox - q.ox;
          const dy = o.oy - q.oy;
          const d = Math.hypot(dx, dy) || 0.01;
          const overlap = o.r + q.r + 2 - d;
          if (overlap > 0) {
            vx += (dx / d) * overlap * 1.5;
            vy += (dy / d) * overlap * 1.5;
          }
        }
      }
      o.ox += vx * dt;
      o.oy += vy * dt;

      if (o.kind === OrganelleKind.ContractileVacuole) {
        // Slowly fills, then empties in a quick squeeze.
        const period = 9 + (i % 3);
        const t = (o.phase % period) / period;
        o.r *= t < 0.93 ? 0.35 + 0.65 * Math.pow(t / 0.93, 0.7) : 1 - ((t - 0.93) / 0.07) * 0.65;
      }

      // Stay inside the membrane, clear of the hyaline rim.
      const d = Math.hypot(o.ox, o.oy);
      const rim = this.traits.motile ? 0.14 : 0.08;
      const limit = Math.max(0, this.radiusAt(Math.atan2(o.oy, o.ox)) - o.r - R * rim);
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

  /** Largest membrane radius (as of the last outline update), for cheap overlap rejection. */
  maxRadius(): number {
    return this.maxR;
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

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Direction and strength (0..1) of the push away from the edges of the drop. */
function wallAvoidance(x: number, y: number, margin: number, b: { w: number; h: number }): { angle: number; strength: number } {
  let ax = 0;
  let ay = 0;
  if (x < margin) ax += (margin - x) / margin;
  if (x > b.w - margin) ax -= (x - (b.w - margin)) / margin;
  if (y < margin) ay += (margin - y) / margin;
  if (y > b.h - margin) ay -= (y - (b.h - margin)) / margin;
  return { angle: Math.atan2(ay, ax), strength: Math.min(1, Math.hypot(ax, ay)) };
}
