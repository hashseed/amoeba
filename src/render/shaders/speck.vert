#version 300 es
uniform vec2 u_res;

layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_speck;   // x, y, radius, blur
layout(location = 2) in vec2 a_shade;   // darkness, opacity

out vec2 v_local;
flat out vec4 v_speck;
flat out vec2 v_shade;

void main() {
  float extent = a_speck.z + a_speck.w * 2.0 + 2.0;
  vec2 p = a_speck.xy + a_corner * extent;
  v_local = a_corner * extent;
  v_speck = a_speck;
  v_shade = a_shade;
  gl_Position = vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, 0.0, 1.0);
}
