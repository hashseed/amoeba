/**
 * Dissolved nutrients on a coarse grid. Dead cells and digestion waste
 * release nutrients locally; algae take them up to grow. Slow diffusion
 * spreads them out, so a death leaves a short-lived fertile patch.
 *
 * Amounts are in the same units as cell mass (px² of cell area).
 */
export class Nutrients {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  private grid: Float32Array;
  private next: Float32Array;
  private diffuseTimer = 0;

  constructor(width: number, height: number, cell: number, initial: number) {
    this.cell = cell;
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    this.grid = new Float32Array(this.cols * this.rows).fill(initial);
    this.next = new Float32Array(this.grid.length);
  }

  private index(x: number, y: number): number {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)));
    return r * this.cols + c;
  }

  level(x: number, y: number): number {
    return this.grid[this.index(x, y)];
  }

  add(x: number, y: number, amount: number): void {
    this.grid[this.index(x, y)] += amount;
  }

  /** Remove up to `amount` at a point; returns how much was actually taken. */
  take(x: number, y: number, amount: number): number {
    const i = this.index(x, y);
    const got = Math.min(amount, this.grid[i]);
    this.grid[i] -= got;
    return got;
  }

  total(): number {
    let s = 0;
    for (const v of this.grid) s += v;
    return s;
  }

  /** Diffuse a little and top up toward a floor level, so the drop never runs dry. */
  step(dt: number, floor: number): void {
    this.diffuseTimer += dt;
    if (this.diffuseTimer < 0.5) return;
    const t = this.diffuseTimer;
    this.diffuseTimer = 0;
    const { cols, rows, grid, next } = this;
    const k = Math.min(0.2, 0.04 * t);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const v = grid[i];
        const l = c > 0 ? grid[i - 1] : v;
        const rr = c < cols - 1 ? grid[i + 1] : v;
        const u = r > 0 ? grid[i - cols] : v;
        const d = r < rows - 1 ? grid[i + cols] : v;
        let n = v + k * (l + rr + u + d - 4 * v);
        if (n < floor) n += (floor - n) * Math.min(1, 0.01 * t);
        next[i] = n;
      }
    }
    this.grid = next;
    this.next = grid;
  }
}
