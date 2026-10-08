#version 300 es
precision highp float;
precision highp int;

// Per-cell data rows: texels [0, 32) hold 64 membrane points (two per texel),
// texels [32, 64) hold up to 16 organelles at two texels each.
uniform highp sampler2D u_data;
uniform float u_time;
uniform float u_px;   // world px per device pixel, for antialiasing

in vec2 v_p;
flat in vec4 v_body;
flat in vec4 v_ink;
flat in vec4 v_glow;
flat in vec4 v_meta;
flat in vec4 v_extra;
out vec4 o;

#include "common.glsl"

const int POINT_TEXELS = 32;
const int ORGANELLE_BASE = 32;
const int MAX_ORGANELLES = 16;

float gBlur;

// Exact signed distance to the membrane polygon (negative inside).
float sdMembrane(vec2 p, int row) {
  vec2 vj = texelFetch(u_data, ivec2(POINT_TEXELS - 1, row), 0).zw;
  float d = 1e9;
  float s = 1.0;
  for (int k = 0; k < POINT_TEXELS; k++) {
    vec4 t = texelFetch(u_data, ivec2(k, row), 0);
    for (int h = 0; h < 2; h++) {
      vec2 vi = h == 0 ? t.xy : t.zw;
      vec2 e = vj - vi;
      vec2 w = p - vi;
      vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
      d = min(d, dot(b, b));
      bvec3 c = bvec3(p.y >= vi.y, p.y < vj.y, e.x * w.y > e.y * w.x);
      if (all(c) || all(not(c))) s = -s;
      vj = vi;
    }
  }
  return s * sqrt(d);
}

// Feature width once defocus and pixel footprint are folded in.
float soft(float w) {
  return sqrt(w * w + gBlur * gBlur + u_px * u_px);
}

// A thin line at sd == 0. Defocus spreads it out and lowers its peak,
// roughly conserving how much ink it puts down.
float line(float sd, float w) {
  float s = soft(w);
  return exp(-0.5 * sd * sd / (s * s)) * (w / s);
}

// Coverage of the region sd < 0 with a soft edge.
float fill(float sd, float w) {
  float s = soft(w);
  return 1.0 - smoothstep(-s, s, sd);
}

// Premultiplied "over", painting back to front.
void over(inout vec4 acc, vec3 col, float a) {
  a = clamp(a, 0.0, 1.0);
  acc = vec4(col * a + acc.rgb * (1.0 - a), a + acc.a * (1.0 - a));
}

void main() {
  gBlur = v_body.w;
  int row = int(v_meta.x + 0.5);
  int organelles = int(v_meta.y + 0.5);
  vec2 center = v_meta.zw;
  float R = v_extra.x;
  float seed = v_glow.w;
  vec3 body = v_body.rgb;
  vec3 ink = v_ink.rgb;
  vec3 glow = v_glow.rgb;
  // Fine texture dissolves as the cell drifts out of focus.
  float sharp = 1.0 / (1.0 + gBlur * 0.35);

  vec2 p = v_p;
  float sd = sdMembrane(p, row);

  vec4 acc = vec4(0.0);

  // Halo: bright-field cells glow faintly where light bends around the membrane.
  float haloW = R * 0.16 + gBlur;
  float halo = exp(-max(sd, 0.0) / haloW) * smoothstep(-3.0 - gBlur, 1.5, sd);
  over(acc, glow, halo * 0.6);

  // Everything below lives inside the membrane; skip it for halo-only pixels.
  if (sd > soft(1.0) * 3.0) {
    acc *= v_ink.w;
    if (acc.a < 0.002) discard;
    o = acc;
    return;
  }

  // Cytoplasm: clear hyaline rim, slightly denser toward the middle.
  float inside = fill(sd, 1.0);
  float depth = -sd;
  float thick = smoothstep(0.0, R * 0.8, depth);
  float ecto = smoothstep(R * 0.03, R * 0.18, depth);
  float tex = fbm((p - center) / (R * 0.5) + seed + vec2(0.0, u_time * 0.015));
  over(acc, body, inside * (0.07 + 0.16 * thick + 0.05 * (tex - 0.5)) * mix(0.45, 1.0, ecto));
  // A soft inner glow just under the membrane.
  over(acc, glow, inside * exp(-depth / (R * 0.08 + gBlur)) * 0.35);

  // Granules streaming through the endoplasm.
  vec2 q = p - center + vec2(seed * 13.1, seed * 7.7);
  float g = max(R * 0.065, 3.5);
  vec2 gq = q / g;
  vec2 gi = floor(gq);
  float gd = 1e9;
  float gsize = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 cell = gi + vec2(x, y);
      vec2 h = hash22(cell + seed);
      vec2 pt = 0.5 + 0.38 * vec2(sin(u_time * (0.3 + h.x * 0.5) + h.y * 6.28), cos(u_time * (0.25 + h.y * 0.4) + h.x * 6.28));
      // Only some lattice cells hold a granule, in a spread of sizes.
      float size = step(0.45, fract(h.x * 7.13 + h.y * 3.7)) * (0.08 + 0.14 * fract(h.y * 11.3));
      float dist = length(gq - cell - pt) * g - size * g;
      if (dist < gd) { gd = dist; gsize = size; }
    }
  }
  float endo = smoothstep(R * 0.1, R * 0.3, depth) * inside;
  float clouds = smoothstep(0.3, 0.7, fbm(q / (R * 0.4) + vec2(u_time * 0.01, 0.0)));
  float granule = fill(gd, 0.6) * step(0.01, gsize);
  over(acc, ink, endo * clouds * (granule * 0.3 * sharp + 0.035));
  // A glint on the larger granules.
  over(acc, vec3(1.0), endo * clouds * fill(gd + gsize * g * 0.5, 0.5) * step(0.15, gsize) * 0.5 * sharp);

  // Organelles.
  for (int k = 0; k < MAX_ORGANELLES; k++) {
    if (k >= organelles) break;
    vec4 A = texelFetch(u_data, ivec2(ORGANELLE_BASE + 2 * k, row), 0);
    vec4 B = texelFetch(u_data, ivec2(ORGANELLE_BASE + 2 * k + 1, row), 0);
    vec2 oc = A.xy;
    float r = A.z;
    int kind = int(floor(A.w));
    float orient = fract(A.w) * 6.2831853;
    float ph = B.x;
    vec3 otint = B.yzw;

    vec2 d = p - oc;
    if (length(d) > r * 1.6 + 3.0 * gBlur + 4.0) continue;
    float ang = atan(d.y, d.x);
    float wob = r * (0.05 * sin(ang * 3.0 + ph * 0.6) + 0.035 * sin(ang * 5.0 - ph * 0.9));
    float so = length(d) - r - wob;

    if (kind == 0) {
      // Nucleus: grainy nucleoplasm, a dense nucleolus, double envelope.
      float inN = fill(so, 1.0);
      float chrom = fbm(d / (r * 0.3) + seed * 3.0 + ph * 0.02);
      over(acc, mix(body, ink, 0.3), inN * (0.2 + 0.18 * chrom));
      float dots = smoothstep(0.62, 0.8, vnoise(d / max(r * 0.09, 1.5) + seed));
      over(acc, ink, inN * dots * 0.22 * sharp);
      vec2 nc = oc + r * 0.28 * vec2(cos(seed * 6.28 + ph * 0.05), sin(seed * 6.28 + ph * 0.05));
      float sn = length(p - nc) - r * 0.3;
      over(acc, ink, fill(sn, 1.5) * 0.3);
      over(acc, ink, line(so, 1.0) * 0.55);
      over(acc, glow, line(so + 2.2, 0.8) * 0.4);
    } else if (kind == 1) {
      // Contractile vacuole: a clear, bright bubble with a crisp edge.
      over(acc, vec3(1.0), fill(so, 1.0) * 0.6);
      over(acc, ink, line(so, 0.9) * 0.5);
      float hl = length(p - (oc - r * vec2(0.3, 0.35))) - r * 0.2;
      over(acc, vec3(1.0), fill(hl, 1.0) * 0.55 * sharp);
    } else if (kind == 2) {
      // Food vacuole: a pale bubble holding a half-digested morsel.
      over(acc, vec3(1.0), fill(so, 1.0) * 0.25);
      vec2 m = d + r * 0.08 * vec2(sin(ph * 0.4), cos(ph * 0.33));
      float morselWob = 0.15 * r * (fbm(d / (r * 0.4) + seed + float(k)) - 0.5);
      float sm = length(m * vec2(1.0, 1.25)) - r * 0.55 - morselWob;
      over(acc, otint, fill(sm, 1.2) * 0.5);
      over(acc, otint * 0.6, line(sm, 0.8) * 0.4 * sharp);
      over(acc, ink, line(so, 0.8) * 0.4);
    } else if (kind == 4) {
      // Chloroplast: a cup-shaped green plastid with fine stacked lamellae and
      // a bright pyrenoid tucked in its hollow.
      vec2 dir = vec2(cos(orient), sin(orient));
      float outer = length(d) - r;
      float hollow = length(d + dir * r * 0.7) - r * 0.68;
      float cup = max(outer, -hollow);
      float body = fill(cup, 1.0);
      vec2 perp = vec2(-dir.y, dir.x);
      float lamellae = 0.5 + 0.5 * sin(dot(d, dir) / max(r * 0.07, 1.2) + dot(d, perp) * 0.02);
      over(acc, otint, body * (0.32 + 0.14 * lamellae * sharp));
      over(acc, otint * 0.7, line(cup, 0.8) * 0.18);
      float pyr = length(d + dir * r * 0.1) - r * 0.2;
      over(acc, vec3(1.0), fill(pyr, 1.0) * 0.35);
      over(acc, otint * 0.6, line(pyr, 0.7) * 0.4 * sharp);
    } else {
      // Lipid droplet: tiny and refractile, bright core with a dark rim.
      over(acc, ink, fill(so, 0.7) * 0.45);
      over(acc, vec3(1.0), fill(so + r * 0.45, 0.6) * 0.8);
    }
  }

  // Algae have a cellulose wall: a second, firmer line just inside the membrane.
  float wall = v_extra.y;
  if (wall > 0.0) over(acc, ink, line(sd + 2.4, 0.9) * 0.22 * wall);

  // Membrane: a fine tinted line with a faint shadow just inside it.
  over(acc, ink, line(sd + 2.0, 1.4) * 0.14);
  over(acc, ink, line(sd, 0.7) * 0.55);

  acc *= v_ink.w;
  if (acc.a < 0.002) discard;
  o = acc;
}
