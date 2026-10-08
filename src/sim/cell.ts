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
  /** 0..1, grows in after being duplicated during division. */
  grow: number;
  /** Free-running phase for pulsing and wobble. */
  phase: number;
  /** Fixed orientation, radians (chloroplasts; the division axis for nuclei). */
  orient: number;
  tint: Rgb;
  /**
   * Progress of a process, 0..1: mitosis for a nucleus, digestion for a food
   * vacuole.
   */
  stage: number;
  /** Food vacuoles: undigested mass left inside, and how much there was. */
  content: number;
  content0: number;
  /** Food vacuoles: the prey cell still visible inside, if any. */
  cell: Cell | null;
  /** Radius the prey had when it was swallowed. */
  cellR0: number;
  /** Residue on its way out of the cell. */
  egest: boolean;
  /** During division: which daughter (+1 or -1 along the axis) this goes to. */
  side: number;
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
  /** Swallowed: sitting in a predator's food vacuole, being digested. */
  Ingested = 4,
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
    divideSeconds: 28,
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
    divideSeconds: 14,
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
/** Colour of indigestible leftovers. */
const RESIDUE: Rgb = [0.52, 0.42, 0.3];

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
  private duplicated = false;
  /** The nucleus has finished dividing into two. */
  private nucleiSplit = false;
  /** 0..1, how far this cell has been digested (only while Ingested). */
  digestion = 0;
  /** Residue pushed out of the cell since the world last looked: positions and mass. */
  readonly expelled: { x: number; y: number; r: number; mass: number }[] = [];
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
      grow: 1,
      phase: rng.range(0, 10),
      orient: rng.range(0, TAU),
      tint,
      stage: 0,
      content,
      content0: content,
      cell: null,
      cellR0: 0,
      egest: false,
      side: 0,
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
        f.content0 = f.content * rng.range(1.2, 3);
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
    if (this.capturedBy) {
      // Being engulfed or digested: the predator moves it; it sits just above
      // the predator in the film so it is drawn inside its vacuole.
      this.z = this.capturedBy.z + 0.001;
      this.visibility = (1 - 0.4 * this.digestion) * this.capturedBy.visibility;
      this.updateOrganelles(dt);
      return;
    }
    this.updateDepth(dt, ctx.rng);
    if (this.state === CellState.Dying) {
      this.dissolve(dt);
      return;
    }
    this.metabolise(dt, ctx.nutrients);
    if (this.state === CellState.Dividing) {
      this.divide(dt, ctx.rng);
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

    // Digest food vacuoles. A freshly swallowed cell sits in a bubble of water;
    // the vacuole then tightens around it while it shrinks and browns, and
    // what can't be digested is left as a small residue to be expelled.
    for (const o of this.organelles) {
      if (o.kind !== OrganelleKind.FoodVacuole || o.egest) continue;
      const digested = Math.min(o.content, (o.content * 0.015 + o.content0 * 0.0015) * dt);
      o.content -= digested;
      this.energy += digested * 0.8;
      nutrients.add(this.cx, this.cy, digested * 0.2);
      const left = o.content / o.content0;
      o.stage = 1 - left;
      const prey = o.cell;
      if (prey) {
        prey.digestion = o.stage;
        prey.shrinkTo(o.cellR0 * Math.sqrt(Math.max(left, 0.04)));
        // A bubble of water around the prey at first, tight later.
        const water = Math.max(0, 1 - o.phase / 25);
        o.size = (prey.radius * (1.06 + 0.14 * water) + 2) / this.radius;
        if (left < 0.25) {
          // Nothing recognisable left: the prey's remains become residue.
          prey.state = CellState.Gone;
          prey.capturedBy = null;
          o.cell = null;
          o.tint = RESIDUE;
        }
      } else {
        o.size = this.vacuoleSize(o.content);
        if (left < 0.12 || o.content < 1) o.egest = true;
      }
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

  /** Shrink the whole outline to a new rest radius (a cell being digested). */
  shrinkTo(radius: number): void {
    const k = radius / this.radius;
    if (k >= 1) return;
    for (let i = 0; i < NODES; i++) this.rs[i] *= k;
    for (const o of this.organelles) {
      o.ox *= k;
      o.oy *= k;
    }
    this.radius = radius;
    this.updateOutline();
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
    this.duplicated = false;
    this.nucleiSplit = false;
    this.pods.length = 0;
    this.target = null;
    const ax = Math.cos(this.divideAxis);
    const ay = Math.sin(this.divideAxis);
    for (const o of this.organelles) o.side = o.ox * ax + o.oy * ay >= 0 ? 1 : -1;
  }

  get divisionDone(): boolean {
    return this.state === CellState.Dividing && this.stateTime >= this.traits.divideSeconds;
  }

  /** Separation of the two lobes and lobe radius at division progress p (cytokinesis). */
  private divisionShape(p: number): { d: number; rho: number } {
    const rc = this.radius / Math.SQRT2;
    const s = smoothstep(0.6, 1, p);
    return { d: s * rc * 0.92, rho: this.radius + (rc - this.radius) * s };
  }

  /**
   * Binary fission, in the order a cell really does it:
   * 1. pseudopods retract and the cell rounds up;
   * 2. the nucleus divides (chromatin condenses, lines up, pulls apart into
   *    two nuclei) while the other organelles are duplicated;
   * 3. the halves gather at opposite poles and the body pinches in at the
   *    waist (cytokinesis) until two daughters separate.
   */
  private divide(dt: number, rng: Rng): void {
    this.stateTime += dt;
    const p = Math.min(1, this.stateTime / this.traits.divideSeconds);
    const { d, rho } = this.divisionShape(p);
    const ax = Math.cos(this.divideAxis);
    const ay = Math.sin(this.divideAxis);

    // Body: pseudopods melt back into a round cell, which later stretches into two lobes.
    const k = Math.min(1, dt * 0.7);
    for (let i = 0; i < NODES; i++) {
      const along = COS[i] * ax + SIN[i] * ay;
      // Far intersection of this ray with either lobe circle (centres ±d along the axis).
      const reach = (c: number) => c * along + Math.sqrt(Math.max(0, c * c * along * along - c * c + rho * rho));
      const target = Math.max(reach(d), reach(-d));
      this.rs[i] += (target - this.rs[i]) * k;
    }

    // Nucleus: mitosis, drawn by the shader from its stage and axis.
    const mitosis = smoothstep(0.1, 0.6, p);
    for (let i = this.organelles.length - 1; i >= 0 && !this.nucleiSplit; i--) {
      const n = this.organelles[i];
      if (n.kind !== OrganelleKind.Nucleus) continue;
      n.orient = this.divideAxis;
      n.stage = mitosis;
      if (mitosis >= 1) {
        this.nucleiSplit = true;
        // Telophase done: two daughter nuclei where the shader drew them.
        const off = n.r * 1.1;
        const twin: Organelle = { ...n, stage: 0, size: n.size * 0.82, side: -1 };
        n.stage = 0;
        n.size *= 0.82;
        n.side = 1;
        twin.ox = n.ox - ax * off;
        twin.oy = n.oy - ay * off;
        n.ox += ax * off;
        n.oy += ay * off;
        // Nuclei go first so they are never the ones dropped for space.
        if (this.organelles.length >= MAX_ORGANELLES) {
          const drop = this.organelles.findIndex((o) => o.kind === OrganelleKind.Droplet);
          if (drop >= 0) this.organelles.splice(drop, 1);
        }
        this.organelles.unshift(twin);
      }
    }

    // Duplicate the other organelles once the nucleus is dividing.
    if (!this.duplicated && p > 0.3) {
      this.duplicated = true;
      this.duplicateOrganelles(rng, ax, ay);
    }

    // Halves gather toward their poles, then into the lobes.
    const pole = Math.max(d, this.radius * 0.35 * smoothstep(0.35, 0.6, p));
    const k2 = Math.min(1, dt * 0.5);
    for (const o of this.organelles) {
      if (o.side === 0) continue;
      const along = o.rx * ax + o.ry * ay;
      const px = (o.rx - ax * along) * rho * 0.55;
      const py = (o.ry - ay * along) * rho * 0.55;
      const lobeSpread = smoothstep(0.3, 0.6, p);
      const tx = ax * o.side * pole + px * lobeSpread + o.rx * rho * 0.5 * (1 - lobeSpread);
      const ty = ay * o.side * pole + py * lobeSpread + o.ry * rho * 0.5 * (1 - lobeSpread);
      o.ox += (tx - o.ox) * k2;
      o.oy += (ty - o.oy) * k2;
    }
  }

  /** Each organelle gets a twin that grows in on the opposite side of the cell. */
  private duplicateOrganelles(rng: Rng, ax: number, ay: number): void {
    const copies: Organelle[] = [];
    let droplets = 0;
    for (const o of this.organelles) {
      const copyable =
        o.kind === OrganelleKind.ContractileVacuole ||
        o.kind === OrganelleKind.Chloroplast ||
        (o.kind === OrganelleKind.Droplet && droplets++ < 3);
      if (!copyable) continue;
      // Mirror across the plane between the daughters.
      const along = o.ox * ax + o.oy * ay;
      const twin: Organelle = {
        ...o,
        ox: o.ox - 2 * along * ax,
        oy: o.oy - 2 * along * ay,
        rx: o.rx - 2 * (o.rx * ax + o.ry * ay) * ax,
        ry: o.ry - 2 * (o.rx * ax + o.ry * ay) * ay,
        side: -o.side,
        grow: 0,
        phase: rng.range(0, 10),
        orient: o.kind === OrganelleKind.Chloroplast ? o.orient + Math.PI : o.orient,
      };
      copies.push(twin);
    }
    for (const c of copies) {
      if (this.organelles.length >= MAX_ORGANELLES) break;
      this.organelles.push(c);
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
      const side = o.side !== 0 ? o.side : o.ox * ax + o.oy * ay >= 0 ? 1 : -1;
      const child = side > 0 ? a : b;
      if (child.organelles.length >= MAX_ORGANELLES) {
        // No room: whatever was inside is digested on the spot.
        if (o.cell) {
          o.cell.state = CellState.Gone;
          o.cell.capturedBy = null;
          child.energy += o.content * 0.8;
        }
        continue;
      }
      if (o.cell) o.cell.capturedBy = child;
      const ox = o.ox - ax * d * side;
      const oy = o.oy - ay * d * side;
      const restScale = 0.7;
      child.organelles.push({
        ...o,
        ox,
        oy,
        rx: (ox / rc) * restScale,
        ry: (oy / rc) * restScale,
        size: o.kind === OrganelleKind.Nucleus ? o.size / 0.82 : o.size,
        side: 0,
        stage: o.kind === OrganelleKind.Nucleus ? 0 : o.stage,
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
    // The cell stops crawling and wraps around its catch.
    this.pods.length = 0;
  }

  /** Let go of prey (when this cell dies or divides). */
  release(): void {
    if (this.prey) this.prey.capturedBy = null;
    this.prey = null;
  }

  /** Radius of the pocket of water kept around prey while it is engulfed. */
  private pocketRadius(prey: Cell): number {
    return prey.radius * 1.2 + 2;
  }

  /**
   * Phagocytosis. The membrane never touches the prey: the front of the cell
   * hollows into a cup around it, two arms flow along its sides and on around
   * the far side until they meet, and the prey ends up sealed in a pocket of
   * water, the new food vacuole.
   */
  private engulf(dt: number): void {
    const prey = this.prey!;
    this.engulfTime += dt;
    const t = this.engulfTime;
    const dx = prey.cx - this.cx;
    const dy = prey.cy - this.cy;
    const dist = Math.hypot(dx, dy) || 1;
    const ang = Math.atan2(dy, dx);
    const H = this.pocketRadius(prey);
    const arm = Math.max(5, prey.radius * 0.55);
    const outer = H + arm;
    // Rays from the centre that pass through the pocket; the arms close over
    // them from both sides inward, so the opening on the far side narrows.
    const hitHalf = Math.asin(Math.min(1, H / dist));
    const close = smoothstep(2.5, 8, t);
    const open = hitHalf * (1 - close);
    const k = Math.min(1, dt * 5);
    let sealed = true;
    for (let i = 0; i < NODES; i++) {
      const a = angleDiff((i / NODES) * TAU, ang);
      if (Math.abs(a) > Math.PI / 2) continue;
      const s = dist * Math.abs(Math.sin(a));
      if (s >= outer) continue;
      const c = dist * Math.cos(a);
      const r = this.rs[i];
      if (s < H && Math.abs(a) < open) {
        // Bottom of the cup: hug the pocket without crossing it.
        const near = c - Math.sqrt(H * H - s * s);
        const far = c + Math.sqrt(H * H - s * s);
        if (r < near) this.rs[i] += (near - r) * k;
        else if (r > (near + far) / 2) this.rs[i] = (near + far) / 2;
        if (s < H * 0.9) sealed = false;
        continue;
      }
      // An arm: reach round the far side of the pocket.
      const want = c + Math.sqrt(outer * outer - s * s);
      if (r < want) this.rs[i] += (want - r) * k;
      if (s < H && this.rs[i] < c + Math.sqrt(H * H - s * s) + arm * 0.4) sealed = false;
    }
    if ((sealed && t > 8) || t > 16 || dist < H + this.radius * 0.25) this.ingest(prey, dx, dy);
  }

  /** The pocket around prey being engulfed, which the renderer keeps clear of cytoplasm. */
  get pocket(): { x: number; y: number; r: number } | null {
    if (this.prey) return { x: this.prey.cx, y: this.prey.cy, r: this.pocketRadius(this.prey) };
    for (const o of this.organelles) {
      if (o.cell) return { x: this.cx + o.ox, y: this.cy + o.oy, r: o.r };
    }
    return null;
  }

  private ingest(prey: Cell, dx: number, dy: number): void {
    const content = prey.mass + Math.max(0, prey.energy);
    prey.state = CellState.Ingested;
    prey.eaten = true;
    prey.target = null;
    this.prey = null;
    if (this.organelles.length >= MAX_ORGANELLES) {
      const drop = this.organelles.findIndex((o) => o.kind === OrganelleKind.Droplet);
      if (drop >= 0) this.organelles.splice(drop, 1);
    }
    if (this.organelles.length >= MAX_ORGANELLES) {
      this.energy += content * 0.8;
      prey.state = CellState.Gone;
      prey.capturedBy = null;
      return;
    }
    const R = this.radius;
    const H = this.pocketRadius(prey);
    this.organelles.push({
      kind: OrganelleKind.FoodVacuole,
      ox: dx,
      oy: dy,
      // It is carried in toward the middle of the cell.
      rx: (dx / R) * 0.35,
      ry: (dy / R) * 0.35,
      r: H,
      size: H / R,
      grow: 1,
      phase: 0,
      orient: 0,
      tint: prey.species === Species.Alga ? chloroplastTint(prey.tint.hue) : prey.tint.body,
      stage: 0,
      content,
      content0: content,
      cell: prey,
      cellR0: prey.radius,
      egest: false,
      side: 0,
    });
    prey.capturedBy = this;
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
    // Residue leaves through the trailing end.
    const rearX = -Math.cos(this.heading) * R;
    const rearY = -Math.sin(this.heading) * R;
    const orgs = this.organelles;
    for (let i = 0; i < orgs.length; i++) {
      const o = orgs[i];
      o.phase += dt;
      o.grow = Math.min(1, o.grow + dt * 0.25);
      o.r = o.size * R * o.grow;
      let vx = 0;
      let vy = 0;
      if (o.egest) {
        vx += (rearX - o.ox) * 0.3;
        vy += (rearY - o.oy) * 0.3;
      } else if (!dividing) {
        const stream = o.kind === OrganelleKind.Nucleus ? 0.01 : 0.025;
        const pull = o.cell ? 0.12 : 0.25;
        vx += (o.rx * R - o.ox) * pull + sx * stream * R;
        vy += (o.ry * R - o.oy) * pull + sy * stream * R;
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
            // A vacuole holding a whole cell is heavy and moves less.
            const give = o.cell ? 1 : 1.5;
            vx += (dx / d) * overlap * give;
            vy += (dy / d) * overlap * give;
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
      const edge = this.radiusAt(Math.atan2(o.oy, o.ox));
      if (o.egest) {
        if (d + o.r > edge - 2) {
          // Out through the membrane: the residue joins the debris in the water.
          const k = (edge + o.r + 2) / (d || 1);
          this.expelled.push({ x: this.cx + o.ox * k, y: this.cy + o.oy * k, r: o.r * 0.6, mass: o.content });
          orgs.splice(i, 1);
          i--;
        }
        continue;
      }
      const rim = o.cell ? 3 / R : this.traits.motile ? 0.14 : 0.08;
      const limit = Math.max(0, edge - o.r - R * rim);
      if (d > limit && d > 0) {
        // A fresh vacuole is drawn in gently rather than snapped inside.
        const k = o.cell ? Math.min(1, dt * 2) : 1;
        const to = d + (limit - d) * k;
        o.ox *= to / d;
        o.oy *= to / d;
      }

      const prey = o.cell;
      if (prey) {
        // The prey stays alive for a while, twitching against the vacuole wall.
        const room = Math.max(0, o.r - prey.radius - 1) * (1 - Math.min(1, prey.digestion * 2));
        prey.cx = this.cx + o.ox + noise1(o.phase * 0.5, prey.seed) * room;
        prey.cy = this.cy + o.oy + noise1(o.phase * 0.5 + 30, prey.seed) * room;
        prey.updateOutline();
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
