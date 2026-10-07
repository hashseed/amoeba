#version 300 es
precision highp float;

uniform float u_px;

in vec2 v_local;
flat in vec4 v_speck;
flat in vec2 v_shade;
out vec4 o;

// A tiny particle; out of focus it spreads into a pale disc with a faint ring.
void main() {
  float r = v_speck.z;
  float b = v_speck.w;
  float d = length(v_local);
  float s = max(b, u_px);
  float disc = 1.0 - smoothstep(r + b - s, r + b + s, d);
  float ring = exp(-pow((d - (r + b * 0.8)) / (s * 0.5 + u_px), 2.0)) * smoothstep(1.0, 4.0, b);
  float spread = (r * r) / ((r + b) * (r + b));
  float a = (disc * mix(1.0, 0.35, smoothstep(0.0, 4.0, b)) + ring * 0.6) * mix(spread, 1.0, 0.18) * v_shade.y;
  vec3 col = mix(vec3(0.55, 0.5, 0.47), vec3(0.3, 0.26, 0.24), v_shade.x);
  o = vec4(col * a, a);
}
