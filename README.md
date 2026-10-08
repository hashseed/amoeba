# Amoeba

A slow, abstract microscope screensaver: translucent single-celled organisms live out their lives in a drop of water under bright-field light. Amoebae crawl after algae, engulf them and digest them in food vacuoles, grow, and divide by mitosis; algae photosynthesise and split; starved cells dissolve back into nutrients that feed the next bloom.

Live at **https://hashseed.github.io/amoeba/**

## Controls

- Double-click or press **F** for fullscreen. The cursor hides when idle and the screen is kept awake where the browser allows it.

URL parameters:

| Param | Meaning |
|---|---|
| `seed=123` | Reproduce a specific scene |
| `speed=4` | Run the simulation faster (preview long-term behaviour) |
| `warmup=20` | Seconds simulated before the first frame (default 20) |
| `debug` | Show fps, quality and population counts |

## Development

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check and build into dist/
```

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.

## How it works

- `src/sim/` is the simulation. Each cell's membrane is a radius function r(θ) around a moving centre: pseudopods are bulges in r(θ), smoothing acts as surface tension, a pressure term preserves area, and the centre flows toward active pseudopods while the membrane stays put. Motion is overdamped, as in real low-Reynolds-number water. All cells share one plane (a thin film under a cover slip), so membranes flatten against each other instead of overlapping.
- The ecology (`cell.ts`, `world.ts`, `nutrients.ts`) is a small energy budget per cell. Algae photosynthesise using dissolved nutrients; amoebae hunt algae (and much smaller amoebae), wrap pseudopods around them and digest them in food vacuoles. Surplus energy becomes growth; past a size threshold a cell divides (the nucleus splits, the body pinches into two lobes). Starving cells shrink and eventually dissolve, returning their matter to a coarse nutrient grid. Amoebae are limited by food, which gives slow predator-prey swings; newcomers drift in from the edges if a species runs low.
- `src/render/` is a small WebGL2 renderer. Each cell is one instanced quad; the fragment shader computes the exact signed distance to the membrane polygon (read from a float data texture) and draws the halo, cytoplasm, granules, organelles and membrane analytically. Defocus is folded into every feature's width, so cells blur smoothly as they drift away from the focal plane. A final pass adds a faint chromatic fringe, vignette and grain.

See [docs/PLAN.md](docs/PLAN.md) for upcoming milestones: the full ecosystem (eating, growth, mitosis), more species, and stirring the water with the mouse.
