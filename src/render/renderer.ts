import { compile, createTarget, deleteTarget, uniforms, type Target } from '../gl/util';
import { MAX_ORGANELLES, NODES, type Cell } from '../sim/cell';
import type { Speck, World } from '../sim/world';
import common from './shaders/common.glsl?raw';
import fullscreenVert from './shaders/fullscreen.vert?raw';
import backgroundFrag from './shaders/background.frag?raw';
import cellVert from './shaders/cell.vert?raw';
import cellFrag from './shaders/cell.frag?raw';
import speckVert from './shaders/speck.vert?raw';
import speckFrag from './shaders/speck.frag?raw';
import postFrag from './shaders/post.frag?raw';

/** Membrane points per cell after smoothing; must match cell.frag. */
const POINTS = 64;
const ROW_TEXELS = POINTS / 2 + MAX_ORGANELLES * 2;
const MAX_CELLS = 128;
const CELL_FLOATS = 24;
const SPECK_FLOATS = 6;

const withCommon = (src: string) => src.replace('#include "common.glsl"', common);

type Uniforms = Record<string, WebGLUniformLocation>;

export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly bg: { prog: WebGLProgram; u: Uniforms };
  private readonly post: { prog: WebGLProgram; u: Uniforms };
  private readonly cell: { prog: WebGLProgram; u: Uniforms; vao: WebGLVertexArrayObject; buf: WebGLBuffer };
  private readonly speck: { prog: WebGLProgram; u: Uniforms; vao: WebGLVertexArrayObject; buf: WebGLBuffer };
  private readonly emptyVao: WebGLVertexArrayObject;
  private readonly dataTex: WebGLTexture;
  private readonly data = new Float32Array(ROW_TEXELS * 4 * MAX_CELLS);
  private cellInstances = new Float32Array(CELL_FLOATS * MAX_CELLS);
  private speckInstances = new Float32Array(0);
  private scene: Target | null = null;
  private dpr = 1;
  private readonly seed: number;

  constructor(gl: WebGL2RenderingContext, seed: number) {
    this.gl = gl;
    this.seed = seed;

    const bgProg = compile(gl, fullscreenVert, withCommon(backgroundFrag));
    this.bg = { prog: bgProg, u: uniforms(gl, bgProg) };
    const postProg = compile(gl, fullscreenVert, withCommon(postFrag));
    this.post = { prog: postProg, u: uniforms(gl, postProg) };
    this.emptyVao = gl.createVertexArray()!;

    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const cellProg = compile(gl, cellVert, withCommon(cellFrag));
    this.cell = { prog: cellProg, u: uniforms(gl, cellProg), ...this.instanced(quad, [4, 4, 4, 4, 4, 4]) };
    const speckProg = compile(gl, speckVert, speckFrag);
    this.speck = { prog: speckProg, u: uniforms(gl, speckProg), ...this.instanced(quad, [4, 2]) };

    this.dataTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, ROW_TEXELS, MAX_CELLS, 0, gl.RGBA, gl.FLOAT, null);
  }

  /** A VAO with the shared corner quad at location 0 and per-instance attributes after it. */
  private instanced(quad: WebGLBuffer, sizes: number[]): { vao: WebGLVertexArrayObject; buf: WebGLBuffer } {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const stride = sizes.reduce((a, b) => a + b, 0) * 4;
    let offset = 0;
    sizes.forEach((size, i) => {
      gl.enableVertexAttribArray(i + 1);
      gl.vertexAttribPointer(i + 1, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(i + 1, 1);
      offset += size * 4;
    });
    gl.bindVertexArray(null);
    return { vao, buf };
  }

  resize(deviceWidth: number, deviceHeight: number, dpr: number): void {
    this.dpr = dpr;
    if (this.scene && this.scene.width === deviceWidth && this.scene.height === deviceHeight) return;
    if (this.scene) deleteTarget(this.gl, this.scene);
    this.scene = createTarget(this.gl, deviceWidth, deviceHeight);
  }

  render(world: World): void {
    const gl = this.gl;
    const scene = this.scene!;
    const res = [world.width, world.height] as const;
    const px = 1 / this.dpr;

    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
    gl.viewport(0, 0, scene.width, scene.height);
    gl.disable(gl.BLEND);

    gl.useProgram(this.bg.prog);
    gl.uniform2f(this.bg.u.u_res, ...res);
    gl.uniform1f(this.bg.u.u_time, world.time);
    gl.uniform1f(this.bg.u.u_seed, (this.seed % 1000) * 0.137);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const far = world.specks.filter((s) => s.z < 0);
    const near = world.specks.filter((s) => s.z >= 0);
    this.drawSpecks(world, far, px);
    this.drawCells(world, px);
    this.drawSpecks(world, near, px);

    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(this.post.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.tex);
    gl.uniform1i(this.post.u.u_scene, 0);
    gl.uniform2f(this.post.u.u_res, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(this.post.u.u_time, world.time);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private drawSpecks(world: World, specks: Speck[], px: number): void {
    if (specks.length === 0) return;
    const gl = this.gl;
    if (this.speckInstances.length < specks.length * SPECK_FLOATS) {
      this.speckInstances = new Float32Array(specks.length * SPECK_FLOATS * 2);
    }
    const out = this.speckInstances;
    let o = 0;
    for (const s of specks) {
      out[o++] = s.x;
      out[o++] = s.y;
      out[o++] = s.r;
      out[o++] = world.blurAt(s.z);
      out[o++] = s.shade;
      out[o++] = 0.5;
    }
    gl.useProgram(this.speck.prog);
    gl.uniform2f(this.speck.u.u_res, world.width, world.height);
    gl.uniform1f(this.speck.u.u_px, px);
    gl.bindVertexArray(this.speck.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.speck.buf);
    gl.bufferData(gl.ARRAY_BUFFER, out.subarray(0, o), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, specks.length);
  }

  private drawCells(world: World, px: number): void {
    const gl = this.gl;
    // Paint back to front so nearer cells layer over farther ones.
    const cells = [...world.cells].sort((a, b) => a.z - b.z).slice(0, MAX_CELLS);
    const inst = this.cellInstances;
    let o = 0;
    cells.forEach((c, row) => {
      this.writeRow(c, row);
      const blur = world.blurAt(c.z);
      // Out of focus, cells lose a little contrast as well as sharpness.
      const contrast = c.visibility / (1 + blur * 0.04);
      const margin = c.radius * 0.7 + blur * 3 + 4;
      const b = c.bounds();
      const { body, ink, glow } = c.tint;
      inst.set(
        [
          b.x0 - margin, b.y0 - margin, b.x1 + margin, b.y1 + margin,
          body[0], body[1], body[2], blur,
          ink[0], ink[1], ink[2], contrast,
          glow[0], glow[1], glow[2], (c.seed % 997) / 997,
          row, c.organelles.length, c.cx, c.cy,
          c.radius, c.traits.wall, 0, 0,
        ],
        o,
      );
      o += CELL_FLOATS;
    });

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dataTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ROW_TEXELS, cells.length, gl.RGBA, gl.FLOAT, this.data);

    gl.useProgram(this.cell.prog);
    gl.uniform2f(this.cell.u.u_res, world.width, world.height);
    gl.uniform1f(this.cell.u.u_time, world.time);
    gl.uniform1f(this.cell.u.u_px, px);
    gl.uniform1i(this.cell.u.u_data, 0);
    gl.bindVertexArray(this.cell.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cell.buf);
    gl.bufferData(gl.ARRAY_BUFFER, inst.subarray(0, o), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cells.length);
  }

  /** Smooth the membrane ring (Catmull-Rom) into the cell's data row, then append organelles. */
  private writeRow(c: Cell, row: number): void {
    const d = this.data;
    let o = row * ROW_TEXELS * 4;
    const { xs, ys } = c;
    for (let k = 0; k < POINTS; k++) {
      const t = (k * NODES) / POINTS;
      const i = Math.floor(t);
      const f = t - i;
      const i0 = (i + NODES - 1) % NODES;
      const i1 = i % NODES;
      const i2 = (i + 1) % NODES;
      const i3 = (i + 2) % NODES;
      d[o++] = catmull(xs[i0], xs[i1], xs[i2], xs[i3], f);
      d[o++] = catmull(ys[i0], ys[i1], ys[i2], ys[i3], f);
    }
    for (let k = 0; k < MAX_ORGANELLES; k++) {
      const org = c.organelles[k];
      if (!org) {
        o += 8;
        continue;
      }
      d[o++] = c.cx + org.ox;
      d[o++] = c.cy + org.oy;
      d[o++] = org.r;
      // Kind in the integer part, orientation (fraction of a turn) in the fraction.
      d[o++] = org.kind + (((org.orient / (Math.PI * 2)) % 1) + 1) % 1 * 0.999;
      d[o++] = org.phase;
      d[o++] = org.tint[0];
      d[o++] = org.tint[1];
      d[o++] = org.tint[2];
    }
  }
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
