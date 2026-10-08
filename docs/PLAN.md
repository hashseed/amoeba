# Amoeba: plan

## Decisions (2026-10-07)
- Bright-field look: light background, pastel cells with slightly varying glow tints.
- Cells are largely transparent, so internal organelles are clearly visible.
- Focus blur: organisms drift in and out of the focal plane.
- One plane (2026-10-08): organisms never overlap, and defocus is only slight.
- Abstract and artsy rather than scientifically literal.
- WebGL2 renderer for portability.
- Mouse stirring is deferred to a later milestone; v1 is passive.

A slow, hypnotic, 2D microscope view of a living pond-water drop. Single-celled organisms drift, feed, grow, engulf each other and divide. Static frontend app on GitHub Pages, source in `~/workspace/amoeba`, pushed to https://github.com/hashseed/amoeba.

## 1. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language / build | TypeScript + Vite | Fast dev server, tiny static output, trivial Pages deploy |
| Rendering | Raw WebGL2 with a thin helper (twgl.js), hand-written GLSL | Full control over membrane, cytoplasm and post-processing shaders; runs on every current browser. PixiJS adds weight without helping with the custom look; WebGPU is an option later. |
| Simulation | Plain TS, fixed timestep, spatial hash | A few hundred cells at 16 to 32 membrane points each is cheap on the CPU. Move to a Web Worker only if profiling says so. |
| UI | No framework; a small hidden overlay panel | Screensaver has almost no UI |
| Deploy | GitHub Actions to GitHub Pages | `npm ci && npm run build`, then `upload-pages-artifact` and `deploy-pages`; Vite `base: '/amoeba/'`; site at hashseed.github.io/amoeba |

## 2. Organisms (v1)

| Organism | Look | Behaviour | Eats | Eaten by |
|---|---|---|---|---|
| Bacteria | Tiny glowing rods and dots in loose swarms | Brownian jitter, fast division | Detritus / nutrients | Everything |
| Phytoplankton (diatoms, Chlorella-like green cells) | Glassy geometric shells with fine etched patterns; green chloroplast dots | Drift passively, grow from light | Light | Ciliates, amoebae |
| Paramecium-style ciliate | Translucent slipper shape, shimmering cilia fringe, contractile vacuole pulsing | Spiral swimming, reverses on collision | Bacteria, algae | Amoebae, Didinium |
| Amoeba | Large soft-body blob, granular cytoplasm, visible nucleus and food vacuoles | Creeps by extending pseudopods toward food (chemotaxis), engulfs prey | Anything clearly smaller | Larger amoebae |
| Didinium (optional) | Barrel shape with cilia bands | Hunts ciliates specifically | Ciliates | Amoebae |

Later candidates: Volvox colonies, Stentor, bioluminescent dinoflagellates that flash when bumped, Vorticella on stalks.

## 3. Simulation model

- **Physics:** each cell is a ring of verlet points with edge springs plus an internal pressure term that preserves area, so cells squish against each other and wobble. Low Reynolds number: velocity follows force with heavy drag, no coasting, which also reads as "slow and calm".
- **Energy:** every organism has mass and energy. Metabolism costs scale with mass; eating or photosynthesis adds it. Growth converts surplus energy into mass (cell area grows).
- **Predation (phagocytosis):** a predator can engulf prey at least about 1.4x smaller. The membrane never crosses the prey: pseudopods form a cup, flow around it and close behind it, sealing it in a pocket of water (the food vacuole). The prey stays visible, twitching at first; the vacuole tightens while the prey shrinks, browns and fades, and the residue drifts to the rear and is expelled as debris.
- **Binary fission:** past a size threshold the cell retracts its pseudopods and rounds up; the nucleus goes through mitosis (chromatin condenses, lines up on a plate, is pulled to the poles, two nuclei re-form and pinch apart); the other organelles duplicate and gather at the poles; only then does the body pinch at the waist into two daughters.
- **Death and recycling:** cells that run out of energy dissolve into detritus on a low-res nutrient grid, which feeds bacteria and closes the loop.
- **Balance:** soft population caps per species and gentle respawning from the edges so the scene never collapses or empties, which matters for a screensaver that runs for hours. A `?seed=` URL param makes scenes reproducible.

## 4. Visual style

- **Microscope look:** bright-field. A warm, luminous pale background with pastel cells, each species (and each individual, slightly) carrying its own glow tint.
- **Transparency:** cell bodies are mostly clear, so organelles (nucleus, vacuoles, chloroplasts, granules, food being digested) are the main visual interest. Membranes read as thin tinted outlines with a soft halo.
- **Abstract:** species are inspired by real protists but free in form and colour; patterns and shapes favour beauty over accuracy.
- **Cells:** membrane drawn as a mesh with a per-vertex "distance to edge" attribute; the fragment shader adds a fresnel rim, soft inner glow, animated noise for cytoplasm granules, nucleus and vacuoles as inner SDFs, and subtle refraction of what lies behind.
- **One plane:** the drop is a thin film under a cover slip, so organisms share one plane, never pass over each other, and flatten where their membranes press together.
- **Focus blur:** each organism sits slightly higher or lower in the film and drifts slowly, so blur stays subtle. It is computed analytically in the cell shader from the distance to the focal plane.
- **Post-processing:** bloom, faint chromatic aberration toward the edges, circular vignette like an eyepiece (toggleable), fine film grain.
- **Motion:** everything eased and slow; the default time scale aims for something visibly happening every few seconds without bustle.

## 5. Performance

- Target 60 fps on a typical laptop at full screen, including 4K with device-pixel-ratio capping.
- Adaptive quality: lower blur and bloom resolution, fewer membrane points, or smaller population when frame time climbs.
- Fixed-timestep sim decoupled from rendering; pause when the tab is hidden.

## 6. Screensaver UX

- Fullscreen on click or `F`; cursor hides after idle; Screen Wake Lock keeps the display on.
- Hidden settings panel on `H`: speed, population, palette, vignette, seed.
- Later milestone: dragging the mouse stirs the water.

## 7. Repo layout

```
amoeba/
  index.html
  vite.config.ts
  src/
    main.ts            app loop
    sim/               world, softbody, species, spatial hash, nutrients
    render/            gl setup, passes, shaders/*.glsl
    ui/                settings overlay
  .github/workflows/deploy.yml
```

## 8. Milestones

1. Scaffold, Pages deploy pipeline, one beautifully rendered soft-body amoeba wobbling on screen.  Done 2026-10-07.
2. Ecosystem core: energy, eating, growth, mitosis, death, nutrient loop, with two species (amoebae and algae). Done 2026-10-08.
3. Remaining species and the full visual pass (focus drift, post-processing).
4. Screensaver polish: wake lock, settings, adaptive quality, long-run balance tuning.
5. Interaction: mouse stirs the water.
