#version 300 es
uniform vec2 u_res;

layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_box;    // x0, y0, x1, y1 (world px)
layout(location = 2) in vec4 a_body;   // rgb, blur
layout(location = 3) in vec4 a_ink;    // rgb, contrast
layout(location = 4) in vec4 a_glow;   // rgb, seed
layout(location = 5) in vec4 a_meta;   // data row, organelle count, centroid
layout(location = 6) in vec4 a_extra;  // radius, unused

out vec2 v_p;
flat out vec4 v_body;
flat out vec4 v_ink;
flat out vec4 v_glow;
flat out vec4 v_meta;
flat out vec4 v_extra;

void main() {
  vec2 t = a_corner * 0.5 + 0.5;
  vec2 p = mix(a_box.xy, a_box.zw, t);
  v_p = p;
  v_body = a_body;
  v_ink = a_ink;
  v_glow = a_glow;
  v_meta = a_meta;
  v_extra = a_extra;
  gl_Position = vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, 0.0, 1.0);
}
