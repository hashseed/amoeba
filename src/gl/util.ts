/** Minimal WebGL2 helpers: just enough to keep the renderer readable. */

export function compile(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = shader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = shader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

function shader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const numbered = src
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(4)}: ${l}`)
      .join('\n');
    throw new Error(`Shader compile failed: ${log}\n${numbered}`);
  }
  return s;
}

/** Look up all active uniforms of a program by name. */
export function uniforms(gl: WebGL2RenderingContext, prog: WebGLProgram): Record<string, WebGLUniformLocation> {
  const out: Record<string, WebGLUniformLocation> = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i)!;
    const name = info.name.replace(/\[0\]$/, '');
    out[name] = gl.getUniformLocation(prog, info.name)!;
  }
  return out;
}

export interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

export function createTarget(gl: WebGL2RenderingContext, width: number, height: number): Target {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, width, height };
}

export function deleteTarget(gl: WebGL2RenderingContext, t: Target): void {
  gl.deleteFramebuffer(t.fbo);
  gl.deleteTexture(t.tex);
}
