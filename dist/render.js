// WebGL2 渲染：河道水面（流速场纹理化 + 程序化水纹/泡沫）、
// 礁石与竹排节实例化绘制、篙、码头、屏幕雨效。
import { NS, NT, T_MIN, T_MAX } from './flowfield.js';
const RIVER_VERT = `#version 300 es
layout(location=0) in vec2 aPos;   // 世界坐标
layout(location=1) in vec2 aST;    // s(0..1), t(-1.15..1.15)
uniform vec2 uCam;
uniform vec2 uView;   // 半宽、半高（世界米）
out vec2 vWorld;
out vec2 vST;
void main(){
  vWorld = aPos; vST = aST;
  vec2 c = (aPos - uCam) / uView;
  gl_Position = vec4(c.x, c.y, 0, 1);
}`;
const RIVER_FRAG = `#version 300 es
precision highp float;
in vec2 vWorld;
in vec2 vST;
uniform sampler2D uFlow;   // R=流向角 G=流速 B=水深
uniform float uTime;
uniform float uLevelMul;
uniform vec3 uRocks[24];   // xy=位置 z=半径
uniform int uRockCount;
out vec4 frag;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p);
  f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}

void main(){
  float t = vST.y;
  if (abs(t) > 1.0) {
    // 两岸：山坡林地
    float n = noise(vWorld*0.15)*0.5 + noise(vWorld*0.6)*0.3;
    float edge = smoothstep(1.0, 1.12, abs(t));
    vec3 land = mix(vec3(0.24,0.34,0.18), vec3(0.16,0.25,0.13), n);
    land = mix(vec3(0.45,0.42,0.33), land, edge); // 水线处一点滩涂
    frag = vec4(land, 1);
    return;
  }
  vec2 uv = vec2(vST.x, (t - (${T_MIN.toFixed(2)})) / (${T_MAX.toFixed(2)} - (${T_MIN.toFixed(2)})));
  vec4 fl = texture(uFlow, uv);
  float ang = fl.r * 6.2831853;
  float spd = fl.g * 4.5;
  float dep = fl.b * 4.0 * uLevelMul;
  vec2 dir = vec2(cos(ang), sin(ang));

  // 水色：浅处青亮，深处墨绿
  float dfac = clamp(dep / 2.5, 0., 1.);
  vec3 shallow = vec3(0.45, 0.66, 0.62);
  vec3 deep = vec3(0.10, 0.28, 0.30);
  vec3 col = mix(shallow, deep, dfac);

  // 顺水流动的亮纹：把世界坐标投到流向的垂直方向做条纹，再按流速平移相位
  float across = dot(vWorld, vec2(-dir.y, dir.x));
  float along = dot(vWorld, dir);
  float streak = sin(across*2.6 + noise(vWorld*0.8)*3.0) * 0.5 + 0.5;
  float adv = noise(vec2(along*0.35 - uTime*spd*0.9, across*0.5));
  col += vec3(0.10) * streak * adv * clamp(spd*0.6,0.2,1.2);

  // 急流白浪：流速快、水浅处泛白
  float foam = smoothstep(2.2, 3.6, spd) + smoothstep(0.7, 0.25, dep)*0.5;
  foam *= 0.55 + 0.45*noise(vWorld*2.0 + vec2(uTime*1.5, 0));
  col = mix(col, vec3(0.9,0.95,0.95), clamp(foam,0.,0.75));

  // 礁石周围一圈水花 + 尾流
  for (int i=0;i<24;i++){
    if (i>=uRockCount) break;
    vec3 rk = uRocks[i];
    float d = distance(vWorld, rk.xy);
    float ring = smoothstep(rk.z+1.2, rk.z+0.2, d) * smoothstep(rk.z*0.4, rk.z*0.95, d);
    col = mix(col, vec3(0.92,0.96,0.96), ring*0.7*(0.6+0.4*sin(uTime*3.+d*4.)));
  }

  // 岸边渐暗（水线）
  col *= 1.0 - smoothstep(0.85, 1.0, abs(t))*0.25;
  frag = vec4(col, 1);
}`;
const INST_VERT = `#version 300 es
layout(location=0) in vec2 aCorner;      // [-0.5..0.5]
layout(location=1) in vec2 iPos;
layout(location=2) in vec2 iScale;
layout(location=3) in float iAngle;
layout(location=4) in vec4 iColor;       // rgb + 状态/参数
layout(location=5) in float iType;       // 0礁石 1竹排节 2篙 3码头
uniform vec2 uCam;
uniform vec2 uView;
out vec2 vLocal;
out vec4 vColor;
out float vType;
void main(){
  float c = cos(iAngle), s = sin(iAngle);
  vec2 p = aCorner * iScale;
  vec2 w = iPos + vec2(p.x*c - p.y*s, p.x*s + p.y*c);
  vLocal = aCorner;
  vColor = iColor;
  vType = iType;
  vec2 cl = (w - uCam) / uView;
  gl_Position = vec4(cl.x, cl.y, 0, 1);
}`;
const INST_FRAG = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec4 vColor;   // rgb, a: 竹排节=完好度
in float vType;
out vec4 frag;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
void main(){
  if (vType < 0.5) {
    // 礁石：圆形、顶部受光
    float d = length(vLocal*2.0);
    if (d > 1.0) discard;
    float shade = 0.75 - 0.35*vLocal.y + 0.15*hash(floor(vLocal*6.0));
    vec3 col = vec3(0.42,0.40,0.38) * shade;
    col = mix(col, vec3(0.65,0.63,0.6), smoothstep(0.7,0.2,d)*0.4);
    frag = vec4(col, smoothstep(1.0, 0.92, d));
  } else if (vType < 1.5) {
    // 竹排节：横向几根竹筒 + 竹节环
    float culms = 6.0;
    float cy = (vLocal.y + 0.5) * culms;
    float cid = floor(cy);
    float inCulm = fract(cy);
    float tube = smoothstep(0.02, 0.12, inCulm) * smoothstep(0.98, 0.88, inCulm);
    float ring = smoothstep(0.06, 0.0, abs(fract(vLocal.x*4.0)-0.5)-0.42);
    float tone = 0.85 + 0.3*hash(vec2(cid, cid*7.0));
    vec3 bamboo = vec3(0.72, 0.62, 0.35) * tone;
    bamboo = mix(bamboo, vec3(0.55,0.45,0.25), ring*0.7);
    bamboo *= 0.55 + 0.45*tube;
    // 完好度低 → 发暗发褐
    bamboo = mix(vec3(0.35,0.25,0.18), bamboo, vColor.a);
    frag = vec4(bamboo * vColor.rgb, 1.0);
  } else if (vType < 2.5) {
    // 篙：一根深色竹竿
    float w = smoothstep(0.5, 0.2, abs(vLocal.y));
    frag = vec4(vec3(0.4,0.32,0.18), w);
  } else {
    // 码头：木平台
    float plank = 0.8 + 0.2*step(0.5, fract(vLocal.x*8.0));
    frag = vec4(vec3(0.45,0.33,0.2)*plank, 1.0);
  }
}`;
const RAIN_VERT = `#version 300 es
void main(){
  vec2 p = vec2((gl_VertexID==1)?3.:-1., (gl_VertexID==2)?1.:-3.);
  gl_Position = vec4(p,0,1);
}`;
const RAIN_FRAG = `#version 300 es
precision highp float;
uniform float uTime;
uniform float uRain;
uniform vec2 uRes;
out vec4 frag;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
void main(){
  if (uRain < 0.01) { frag = vec4(0.16,0.2,0.22, uRain*0.25); return; }
  vec2 uv = gl_FragCoord.xy / uRes;
  float drops = 0.0;
  for (int layer=0; layer<2; layer++){
    float fl = float(layer);
    vec2 g = vec2(uv.x*30.0*(1.0+fl*0.7), uv.y*3.0 + uTime*(2.2+fl));
    vec2 id = vec2(floor(g.x), floor(g.y));
    float h = hash(id + fl*17.0);
    float x = fract(g.x) - 0.5 - (h-0.5)*0.6;
    float y = fract(g.y);
    float drop = smoothstep(0.06,0.0,abs(x)) * smoothstep(0.5,0.2,abs(y-0.5)) * step(0.6, h);
    drops += drop;
  }
  vec3 col = mix(vec3(0.16,0.2,0.22), vec3(0.75,0.82,0.88), clamp(drops,0.,1.));
  float alpha = uRain*0.22 + clamp(drops,0.,1.)*uRain*0.5;
  frag = vec4(col, alpha);
}`;
function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('Shader error: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
}
function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error('Link error: ' + gl.getProgramInfoLog(p));
    }
    return p;
}
const MAX_INST = 128;
export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.riverVAO = null;
        this.riverIndexCount = 0;
        this.flowTex = null;
        this.instVAO = null;
        this.instVBO = null;
        this.rainVAO = null;
        this.rocks = [];
        // 实例数据暂存
        this.instData = new Float32Array(MAX_INST * 10);
        const gl = canvas.getContext('webgl2', { antialias: true });
        if (!gl)
            throw new Error('需要 WebGL2 支持');
        this.gl = gl;
        this.riverProg = program(gl, RIVER_VERT, RIVER_FRAG);
        this.instProg = program(gl, INST_VERT, INST_FRAG);
        this.rainProg = program(gl, RAIN_VERT, RAIN_FRAG);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    /** 装载一条河：建河道网格与流场纹理 */
    setRiver(geo, flow, rocks) {
        this.rocks = rocks;
        const gl = this.gl;
        // --- 河道条带网格 ---
        const NA = 260, NC = 14; // 沿程 × 横向
        const verts = new Float32Array(NA * NC * 4);
        const n = geo.samples.length - 1;
        for (let i = 0; i < NA; i++) {
            const sNorm = i / (NA - 1);
            const smp = geo.samples[Math.round(sNorm * n)];
            for (let j = 0; j < NC; j++) {
                const t = T_MIN + (T_MAX - T_MIN) * (j / (NC - 1));
                const k = (i * NC + j) * 4;
                verts[k] = smp.pos.x + smp.normal.x * t * smp.halfWidth;
                verts[k + 1] = smp.pos.y + smp.normal.y * t * smp.halfWidth;
                verts[k + 2] = sNorm;
                verts[k + 3] = t;
            }
        }
        const idx = new Uint32Array((NA - 1) * (NC - 1) * 6);
        let q = 0;
        for (let i = 0; i < NA - 1; i++) {
            for (let j = 0; j < NC - 1; j++) {
                const a = i * NC + j, b = a + NC;
                idx[q++] = a;
                idx[q++] = b;
                idx[q++] = a + 1;
                idx[q++] = a + 1;
                idx[q++] = b;
                idx[q++] = b + 1;
            }
        }
        this.riverIndexCount = idx.length;
        if (this.riverVAO)
            gl.deleteVertexArray(this.riverVAO);
        this.riverVAO = gl.createVertexArray();
        gl.bindVertexArray(this.riverVAO);
        const vb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
        const ib = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        // --- 流场纹理 ---
        if (this.flowTex)
            gl.deleteTexture(this.flowTex);
        const data = new Uint8Array(NS * NT * 4);
        for (let i = 0; i < NS; i++) {
            for (let j = 0; j < NT; j++) {
                const c = flow.rawCell(i, j);
                const k = (i * NT + j) * 4;
                const ang = Math.atan2(c.vy, c.vx);
                data[k] = Math.round(((ang + Math.PI) / (2 * Math.PI)) * 255);
                data[k + 1] = Math.round(Math.min(1, Math.hypot(c.vx, c.vy) / 4.5) * 255);
                data[k + 2] = Math.round(Math.min(1, c.depth / 4) * 255);
                data[k + 3] = 255;
            }
        }
        this.flowTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.flowTex);
        // 纹理坐标：x=横向(j)，y=沿程(i)
        const texData = new Uint8Array(NS * NT * 4);
        for (let i = 0; i < NS; i++) {
            for (let j = 0; j < NT; j++) {
                const src = (i * NT + j) * 4;
                const dst = (i * NT + j) * 4;
                texData[dst] = data[src];
                texData[dst + 1] = data[src + 1];
                texData[dst + 2] = data[src + 2];
                texData[dst + 3] = 255;
            }
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, NT, NS, 0, gl.RGBA, gl.UNSIGNED_BYTE, texData);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // --- 实例 VAO ---
        if (!this.instVAO) {
            this.instVAO = gl.createVertexArray();
            gl.bindVertexArray(this.instVAO);
            const quad = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, quad);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            this.instVBO = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.instVBO);
            gl.bufferData(gl.ARRAY_BUFFER, MAX_INST * 10 * 4, gl.DYNAMIC_DRAW);
            const stride = 40;
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
            gl.vertexAttribDivisor(1, 1);
            gl.enableVertexAttribArray(2);
            gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 8);
            gl.vertexAttribDivisor(2, 1);
            gl.enableVertexAttribArray(3);
            gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 16);
            gl.vertexAttribDivisor(3, 1);
            gl.enableVertexAttribArray(4);
            gl.vertexAttribPointer(4, 4, gl.FLOAT, false, stride, 20);
            gl.vertexAttribDivisor(4, 1);
            gl.enableVertexAttribArray(5);
            gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 36);
            gl.vertexAttribDivisor(5, 1);
        }
        if (!this.rainVAO)
            this.rainVAO = gl.createVertexArray();
        gl.bindVertexArray(null);
    }
    render(cam, viewHalfH, raft, pole, weather, time, dockPos, dockAngle) {
        const gl = this.gl;
        const w = this.canvas.width, h = this.canvas.height;
        gl.viewport(0, 0, w, h);
        gl.clearColor(0.13, 0.2, 0.12, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const aspect = w / h;
        const view = { x: viewHalfH * aspect, y: viewHalfH };
        // --- 河道 ---
        gl.useProgram(this.riverProg);
        gl.bindVertexArray(this.riverVAO);
        gl.uniform2f(gl.getUniformLocation(this.riverProg, 'uCam'), cam.x, cam.y);
        gl.uniform2f(gl.getUniformLocation(this.riverProg, 'uView'), view.x, view.y);
        gl.uniform1f(gl.getUniformLocation(this.riverProg, 'uTime'), time);
        gl.uniform1f(gl.getUniformLocation(this.riverProg, 'uLevelMul'), weather.levelMul);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.flowTex);
        gl.uniform1i(gl.getUniformLocation(this.riverProg, 'uFlow'), 0);
        const rockLoc = gl.getUniformLocation(this.riverProg, 'uRocks');
        const rockArr = new Float32Array(24 * 3);
        const rc = Math.min(24, this.rocks.length);
        for (let i = 0; i < rc; i++) {
            rockArr[i * 3] = this.rocks[i].pos.x;
            rockArr[i * 3 + 1] = this.rocks[i].pos.y;
            rockArr[i * 3 + 2] = this.rocks[i].r;
        }
        gl.uniform3fv(rockLoc, rockArr);
        gl.uniform1i(gl.getUniformLocation(this.riverProg, 'uRockCount'), rc);
        gl.drawElements(gl.TRIANGLES, this.riverIndexCount, gl.UNSIGNED_INT, 0);
        // --- 实例：礁石 + 竹排 + 篙 + 码头 ---
        let nInst = 0;
        const put = (x, y, sx, sy, ang, r, g, b, a, type) => {
            if (nInst >= MAX_INST)
                return;
            const k = nInst * 10;
            this.instData[k] = x;
            this.instData[k + 1] = y;
            this.instData[k + 2] = sx;
            this.instData[k + 3] = sy;
            this.instData[k + 4] = ang;
            this.instData[k + 5] = r;
            this.instData[k + 6] = g;
            this.instData[k + 7] = b;
            this.instData[k + 8] = a;
            this.instData[k + 9] = type;
            nInst++;
        };
        // 码头平台
        put(dockPos.x, dockPos.y, 10, 6, dockAngle, 1, 1, 1, 1, 3);
        // 礁石
        for (const rk of this.rocks)
            put(rk.pos.x, rk.pos.y, rk.r * 2, rk.r * 2, 0, 1, 1, 1, 1, 0);
        // 竹排节（状态着色：搁浅偏褐、卡住泛红）
        for (const sec of raft.sections) {
            let r = 1, g = 1, b = 1;
            if (sec.stuck) {
                r = 1.15;
                g = 0.75;
                b = 0.7;
            }
            else if (sec.grounded) {
                r = 1.05;
                g = 0.9;
                b = 0.75;
            }
            put(sec.pos.x, sec.pos.y, raft.cfg.sectionLength * 0.96, 1.7, sec.angle, r, g, b, sec.condition, 1);
        }
        // 篙
        if (pole.state === 'planted') {
            const head = raft.head.pos;
            const dx = pole.plantPoint.x - head.x, dy = pole.plantPoint.y - head.y;
            const L = Math.hypot(dx, dy);
            put((head.x + pole.plantPoint.x) / 2, (head.y + pole.plantPoint.y) / 2, L, 0.14, Math.atan2(dy, dx), 1, 1, 1, 1, 2);
        }
        gl.useProgram(this.instProg);
        gl.bindVertexArray(this.instVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instVBO);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instData.subarray(0, nInst * 10));
        gl.uniform2f(gl.getUniformLocation(this.instProg, 'uCam'), cam.x, cam.y);
        gl.uniform2f(gl.getUniformLocation(this.instProg, 'uView'), view.x, view.y);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nInst);
        // --- 雨 ---
        if (weather.rain > 0.01) {
            gl.useProgram(this.rainProg);
            gl.bindVertexArray(this.rainVAO);
            gl.uniform1f(gl.getUniformLocation(this.rainProg, 'uTime'), time);
            gl.uniform1f(gl.getUniformLocation(this.rainProg, 'uRain'), weather.rain);
            gl.uniform2f(gl.getUniformLocation(this.rainProg, 'uRes'), w, h);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        gl.bindVertexArray(null);
    }
}
//# sourceMappingURL=render.js.map