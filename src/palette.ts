import type { Rng } from './sim/rng';

export type Rgb = [number, number, number];

/** Pastel hues (degrees) the cells draw their tints from. */
const HUES = [340, 12, 28, 48, 150, 172, 196, 222, 262, 290];

export interface CellTint {
  /** Soft body colour, used for the cytoplasm fill. */
  body: Rgb;
  /** Deeper shade of the same hue for membranes and organelle edges. */
  ink: Rgb;
  /** Light, slightly hue-shifted colour of the halo around the cell. */
  glow: Rgb;
}

export function randomTint(rng: Rng): CellTint {
  const h = rng.pick(HUES) + rng.range(-10, 10);
  const glowShift = rng.range(-35, 35);
  return {
    body: hsl(h, 0.55, 0.72),
    ink: hsl(h + 8, 0.4, 0.45),
    glow: hsl(h + glowShift, 0.85, 0.9),
  };
}

/** Colours of whatever is being digested inside food vacuoles. */
export function foodTint(rng: Rng): Rgb {
  return rng.pick<Rgb>([
    hsl(95, 0.45, 0.55),
    hsl(130, 0.35, 0.5),
    hsl(38, 0.6, 0.6),
    hsl(18, 0.5, 0.62),
    hsl(330, 0.35, 0.62),
  ]);
}

export function hsl(hDeg: number, s: number, l: number): Rgb {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
