#version 300 es
precision highp float;

uniform vec2 u_res;   // world size, CSS px
uniform float u_time;
uniform float u_seed;

in vec2 v_uv;
out vec4 o;

#include "common.glsl"

// Bright-field illumination: a warm, luminous field with faint pastel
// blotches of out-of-focus matter drifting far below the focal plane.
void main() {
  vec2 p = vec2(v_uv.x, 1.0 - v_uv.y) * u_res;
  float unit = min(u_res.x, u_res.y);
  vec2 q = p / unit;

  vec3 base = vec3(0.958, 0.942, 0.910);
  float lamp = 1.0 - 0.06 * dot(v_uv - 0.5, v_uv - 0.5) * 2.0;

  vec2 drift = vec2(u_time * 0.004, u_time * 0.0025);
  float n1 = fbm(q * 1.3 + drift + u_seed);
  float n2 = fbm(q * 0.9 - drift * 1.4 + u_seed * 1.7 + 11.0);
  vec3 rose = vec3(0.985, 0.915, 0.925);
  vec3 sage = vec3(0.915, 0.955, 0.925);
  vec3 col = base;
  col = mix(col, rose, smoothstep(0.45, 0.85, n1) * 0.55);
  col = mix(col, sage, smoothstep(0.5, 0.85, n2) * 0.45);

  // Very soft, large shadows of something far out of focus.
  float shade = smoothstep(0.55, 0.9, fbm(q * 0.6 + drift * 0.6 + u_seed * 3.1 + 40.0));
  col *= 1.0 - shade * 0.035;

  o = vec4(col * lamp, 1.0);
}
