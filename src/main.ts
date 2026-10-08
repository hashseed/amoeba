import { Renderer } from './render/renderer';
import { Species } from './sim/cell';
import { World } from './sim/world';

const SIM_DT = 1 / 60;
const MAX_DPR = 2;

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || Math.floor(Math.random() * 1e9);
/** Simulation speed multiplier, handy for previewing long-run behaviour. */
const speed = Number(params.get('speed')) || 1;
/** Seconds simulated before the first frame, so the scene opens mid-motion. */
const warmup = Number(params.get('warmup') ?? 20);

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true, powerPreference: 'high-performance' });

if (!gl) {
  document.body.classList.add('no-webgl');
} else {
  start(gl);
}

function start(gl: WebGL2RenderingContext): void {
  const renderer = new Renderer(gl, seed);
  const world = new World(seed, window.innerWidth, window.innerHeight);
  for (let t = 0; t < warmup; t += SIM_DT) world.step(SIM_DT);

  // Lowered automatically if frames run slow.
  let quality = 1;

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR) * quality;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    world.resize(w, h);
    renderer.resize(canvas.width, canvas.height, dpr);
  };
  window.addEventListener('resize', resize);
  resize();

  let last = performance.now();
  let acc = 0;
  let slowFrames = 0;
  const fps = params.has('debug') ? createFpsMeter() : null;

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    acc += dt * speed;
    let steps = 0;
    while (acc >= SIM_DT && steps < 8) {
      world.step(SIM_DT);
      acc -= SIM_DT;
      steps++;
    }
    if (steps === 8) acc = 0;

    renderer.render(world);

    // Sustained frames slower than ~40 fps drop the render resolution a notch.
    slowFrames = dt > 1 / 40 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
    if (slowFrames > 90 && quality > 0.5) {
      quality = Math.max(0.5, quality - 0.15);
      slowFrames = 0;
      resize();
    }
    fps?.(dt, quality, world);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  setupScreensaverChrome();
}

/** Fullscreen on double-click or F, hide the cursor when idle, keep the screen awake. */
function setupScreensaverChrome(): void {
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  };
  window.addEventListener('dblclick', toggleFullscreen);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  });

  let idleTimer = 0;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => document.body.classList.add('idle'), 2500);
  };
  window.addEventListener('pointermove', wake);
  wake();

  let lock: WakeLockSentinel | null = null;
  const requestLock = async () => {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || lock) return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => (lock = null));
    } catch {
      // Not allowed here (e.g. battery saver); the app works fine without it.
    }
  };
  document.addEventListener('visibilitychange', requestLock);
  window.addEventListener('pointerdown', requestLock);
  void requestLock();
}

function createFpsMeter(): (dt: number, quality: number, world: World) => void {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:8px;left:8px;font:12px ui-monospace,monospace;color:#6b5d55;background:#fff8;padding:2px 6px;border-radius:4px';
  document.body.append(el);
  let avg = 1 / 60;
  return (dt, quality, world) => {
    avg = avg * 0.95 + dt * 0.05;
    const s = world.stats;
    el.textContent =
      `${(1 / avg).toFixed(0)} fps · quality ${quality.toFixed(2)} · seed ${seed} · ` +
      `amoebae ${world.count(Species.Amoeba)} · algae ${world.count(Species.Alga)} · ` +
      `divisions ${s.divisions} · meals ${s.meals} · deaths ${s.deaths}`;
  };
}
