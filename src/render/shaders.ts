export const COLOR_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec4 aColor;
uniform vec2 uCam;
uniform vec2 uRes;
uniform float uScale;
out vec4 vColor;
void main() {
  vec2 d = (aPos - uCam) * uScale;
  gl_Position = vec4(d.x * 2.0 / uRes.x, -d.y * 2.0 / uRes.y, 0.0, 1.0);
  vColor = aColor;
}
`;

export const COLOR_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }
`;

export const WATER_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in float aSide;
layout(location=2) in float aDepth;
layout(location=3) in float aSpeed;
layout(location=4) in vec2 aFlow;
uniform vec2 uCam;
uniform vec2 uRes;
uniform float uScale;
out vec2 vWorld;
out float vSide;
out float vDepth;
out float vSpeed;
out vec2 vFlow;
void main() {
  vec2 d = (aPos - uCam) * uScale;
  gl_Position = vec4(d.x * 2.0 / uRes.x, -d.y * 2.0 / uRes.y, 0.0, 1.0);
  vWorld = aPos;
  vSide = aSide;
  vDepth = aDepth;
  vSpeed = aSpeed;
  vFlow = aFlow;
}
`;

export const WATER_FS = `#version 300 es
precision highp float;
in vec2 vWorld;
in float vSide;
in float vDepth;
in float vSpeed;
in vec2 vFlow;
uniform float uTime;
uniform float uRain;
out vec4 outColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
}
void main() {
  float depthN = clamp((vDepth - 0.08) / 3.4, 0.0, 1.0);
  vec3 sand = vec3(0.70, 0.61, 0.39);
  vec3 shallow = vec3(0.20, 0.62, 0.60);
  vec3 mid = vec3(0.055, 0.36, 0.50);
  vec3 deep = vec3(0.018, 0.13, 0.29);
  vec3 col = mix(shallow, mid, smoothstep(0.05, 0.55, depthN));
  col = mix(col, deep, smoothstep(0.48, 1.0, depthN));
  float showSand = 1.0 - smoothstep(0.18, 0.72, vDepth);
  col = mix(col, sand, showSand * 0.72);

  float fl = max(length(vFlow), 0.001);
  vec2 dir = vFlow / fl;
  vec2 crossDir = vec2(-dir.y, dir.x);
  float along = dot(vWorld, dir);
  float across = dot(vWorld, crossDir);
  float n1 = noise(vec2(along * 0.22 - uTime * (1.2 + fl * 0.55), across * 1.7));
  float streak = smoothstep(0.58, 0.92, n1);
  float speedN = clamp(vSpeed / 6.2, 0.0, 1.4);
  col += vec3(0.10, 0.18, 0.20) * streak * (0.10 + 0.16 * speedN);

  float ripple = sin(along * 2.1 + across * 0.7 - uTime * (2.0 + fl)) * 0.5 + 0.5;
  col += vec3(0.05, 0.10, 0.12) * smoothstep(0.82, 1.0, ripple) * 0.16;

  float edge = smoothstep(0.78, 0.98, abs(vSide));
  float edgeFoam = edge * smoothstep(0.45, 0.9, noise(vWorld * 0.55 + uTime * 0.25));
  col = mix(col, vec3(0.86, 0.96, 0.95), edgeFoam * 0.55);

  if (uRain > 0.01) {
    float rp = hash(floor(vWorld * 1.7) + floor(uTime * 9.0));
    col += vec3(0.55, 0.70, 0.78) * step(0.985 - uRain * 0.025, rp) * 0.22;
  }
  outColor = vec4(col, 1.0);
}
`;

export const RAFT_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 iA;
layout(location=2) in vec4 iB;
layout(location=3) in vec2 iC;
uniform vec2 uCam;
uniform vec2 uRes;
uniform float uScale;
out vec2 vObj;
out vec4 vData;
out vec2 vSeed;
out float vLen;
void main() {
  vec2 pos = iA.xy;
  float ang = iA.z;
  float len = iA.w;
  float wid = iB.x;
  vec2 local = aCorner * vec2(len, wid);
  float c = cos(ang), s = sin(ang);
  vec2 rotated = mat2(c, s, -s, c) * local;
  vec2 world = pos + rotated;
  vec2 d = (world - uCam) * uScale;
  gl_Position = vec4(d.x * 2.0 / uRes.x, -d.y * 2.0 / uRes.y, 0.0, 1.0);
  vObj = local;
  vData = iB;
  vSeed = iC;
  vLen = len;
}
`;

export const RAFT_FS = `#version 300 es
precision highp float;
in vec2 vObj;
in vec4 vData; // width, hp, impact, ground
in vec2 vSeed; // seed, bamboos
in float vLen;
out vec4 outColor;

float hash(float n) { return fract(sin(n * 91.345) * 47453.5453); }
void main() {
  float wid = vData.x;
  float len = vLen;
  vec2 halfSize = vec2(len * 0.5, wid * 0.5);
  float radius = min(wid * 0.24, 0.22);
  vec2 q = abs(vObj) - halfSize + radius;
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  if (sd > 0.035) discard;

  float logs = max(3.0, vSeed.y);
  float gy = (vObj.y / wid + 0.5) * logs;
  float logId = floor(gy);
  float fu = fract(gy);
  float variation = hash(logId + vSeed.x * 17.0);
  vec3 bamboo = mix(vec3(0.48, 0.36, 0.16), vec3(0.78, 0.64, 0.34), variation);
  float groove = smoothstep(0.0, 0.10, min(fu, 1.0 - fu));
  bamboo *= 0.58 + 0.42 * groove;

  float ax = vObj.x + len * 0.5;
  float nodeRing = 1.0 - smoothstep(0.018, 0.055, abs(fract(ax / 0.62 + variation) - 0.5) * 0.62);
  bamboo = mix(bamboo, vec3(0.25, 0.20, 0.10), nodeRing * 0.55);

  float strapA = 1.0 - smoothstep(0.035, 0.08, abs(abs(vObj.x) - len * 0.31));
  bamboo = mix(bamboo, vec3(0.20, 0.13, 0.07), strapA * 0.82);

  float edge = smoothstep(-0.02, 0.035, sd);
  bamboo = mix(bamboo, vec3(0.16, 0.10, 0.05), edge * 0.75);

  float hp = vData.y;
  float crack = 0.0;
  if (hp < 0.72) {
    float cx = abs(fract(vObj.x * 1.7 + hash(vSeed.x)) - 0.5);
    float cy = abs(vObj.y - (hash(floor(vObj.x * 2.0) + vSeed.x) - 0.5) * wid * 0.55);
    crack = (1.0 - smoothstep(0.015, 0.055, cy)) * step(0.45, cx) * (1.0 - hp);
  }
  bamboo = mix(bamboo, vec3(0.08, 0.055, 0.03), clamp(crack * 1.8, 0.0, 0.85));
  bamboo = mix(bamboo, vec3(1.0), clamp(vData.z, 0.0, 1.0) * 0.65);
  if (vData.w > 0.03) {
    float warnEdge = smoothstep(-0.16, 0.02, sd);
    bamboo = mix(bamboo, vec3(0.95, 0.35, 0.08), warnEdge * clamp(vData.w * 1.8, 0.0, 0.75));
  }
  float alpha = 1.0 - smoothstep(0.015, 0.04, sd);
  outColor = vec4(bamboo, alpha);
}
`;

export const CIRCLE_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 iPosRadius;
layout(location=2) in vec4 iColor;
layout(location=3) in float iSeed;
uniform vec2 uCam;
uniform vec2 uRes;
uniform float uScale;
out vec2 vUv;
out vec4 vColor;
out float vSeed;
void main() {
  vec2 world = iPosRadius.xy + aCorner * iPosRadius.z * 1.22;
  vec2 d = (world - uCam) * uScale;
  gl_Position = vec4(d.x * 2.0 / uRes.x, -d.y * 2.0 / uRes.y, 0.0, 1.0);
  vUv = aCorner;
  vColor = iColor;
  vSeed = iSeed;
}
`;

export const CIRCLE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
in float vSeed;
out vec4 outColor;
void main() {
  float d = length(vUv);
  float angle = atan(vUv.y, vUv.x);
  float irregular = 0.92 + 0.08 * sin(angle * 5.0 + vSeed * 11.0) + 0.04 * sin(angle * 9.0);
  if (d > irregular) discard;
  float light = clamp(1.18 - d * 0.55 + (-vUv.x * 0.18 + vUv.y * 0.22), 0.45, 1.25);
  vec3 col = vColor.rgb * light;
  float rim = smoothstep(irregular - 0.16, irregular - 0.02, d);
  col = mix(col, vec3(0.08, 0.09, 0.08), rim * 0.45);
  outColor = vec4(col, vColor.a);
}
`;

export const POINT_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in float aSize;
layout(location=2) in vec4 aColor;
uniform vec2 uCam;
uniform vec2 uRes;
uniform float uScale;
out vec4 vColor;
void main() {
  vec2 d = (aPos - uCam) * uScale;
  gl_Position = vec4(d.x * 2.0 / uRes.x, -d.y * 2.0 / uRes.y, 0.0, 1.0);
  gl_PointSize = max(1.0, aSize * uScale * 2.0);
  vColor = aColor;
}
`;

export const POINT_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float d = length(p) * 2.0;
  float a = (1.0 - smoothstep(0.55, 1.0, d)) * vColor.a;
  outColor = vec4(vColor.rgb, a);
}
`;
