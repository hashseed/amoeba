#version 300 es
precision highp float;

uniform sampler2D u_scene;
uniform vec2 u_res;   // device px
uniform float u_time;

in vec2 v_uv;
out vec4 o;

#include "common.glsl"

// Lens finish: faint chromatic fringe toward the edges, warm vignette, grain.
void main() {
  vec2 c = v_uv - 0.5;
  float aspect = u_res.x / u_res.y;
  vec2 ca = c * vec2(aspect, 1.0);
  float r = length(ca) / length(vec2(aspect, 1.0) * 0.5);

  vec2 off = c * 0.004 * r * r;
  vec3 col;
  col.r = texture(u_scene, v_uv + off).r;
  col.g = texture(u_scene, v_uv).g;
  col.b = texture(u_scene, v_uv - off).b;

  float vig = smoothstep(0.45, 1.15, r);
  col *= mix(vec3(1.0), vec3(0.9, 0.86, 0.82), vig);

  float g = hash12(gl_FragCoord.xy + fract(u_time * 7.13) * vec2(131.0, 71.0)) - 0.5;
  col += g * 0.025;

  o = vec4(col, 1.0);
}
