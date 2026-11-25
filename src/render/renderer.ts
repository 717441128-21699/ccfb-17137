import type { RaftSimulation } from '../game/raft';
import type { WaterModel } from '../game/flow';
import type { Vec2 } from '../game/types';
import {
  CIRCLE_FS,
  CIRCLE_VS,
  COLOR_FS,
  COLOR_VS,
  POINT_FS,
  POINT_VS,
  RAFT_FS,
  RAFT_VS,
  WATER_FS,
  WATER_VS,
} from './shaders';
import { clamp } from '../game/math';

interface Camera {
  x: number;
  y: number;
  cssScale: number;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to create WebGL shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}\n${source}`);
  }
  return shader;
}

function makeProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error('Unable to create WebGL program');
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(p)}`);
  return p;
}

class ColorBatch {
  data: number[] = [];

  clear() {
    this.data.length = 0;
  }

  vertex(x: number, y: number, r: number, g: number, b: number, a: number) {
    this.data.push(x, y, r, g, b, a);
  }

  quad(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    width: number,
    color: [number, number, number, number],
  ) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * width * 0.5;
    const ny = (dx / l) * width * 0.5;
    const [r, g, b, a] = color;
    this.vertex(x1 + nx, y1 + ny, r, g, b, a);
    this.vertex(x1 - nx, y1 - ny, r, g, b, a);
    this.vertex(x2 + nx, y2 + ny, r, g, b, a);
    this.vertex(x2 + nx, y2 + ny, r, g, b, a);
    this.vertex(x1 - nx, y1 - ny, r, g, b, a);
    this.vertex(x2 - nx, y2 - ny, r, g, b, a);
  }

  ring(cx: number, cy: number, radius: number, width: number, color: [number, number, number, number], segments = 28) {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      this.quad(
        cx + Math.cos(a0) * radius,
        cy + Math.sin(a0) * radius,
        cx + Math.cos(a1) * radius,
        cy + Math.sin(a1) * radius,
        width,
        color,
      );
    }
  }
}

export class GameRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  private colorProgram: WebGLProgram;
  private waterProgram: WebGLProgram;
  private raftProgram: WebGLProgram;
  private circleProgram: WebGLProgram;
  private pointProgram: WebGLProgram;

  private colorVao: WebGLVertexArrayObject;
  private colorBuffer: WebGLBuffer;
  private waterVao: WebGLVertexArrayObject | null = null;
  private waterIndexCount = 0;
  private staticColorVao: WebGLVertexArrayObject | null = null;
  private staticColorCount = 0;
  private circleVao: WebGLVertexArrayObject | null = null;
  private circleCount = 0;
  private raftVao: WebGLVertexArrayObject;
  private raftBuffer: WebGLBuffer;
  private pointVao: WebGLVertexArrayObject;
  private pointBuffer: WebGLBuffer;

  private dynamicBatch = new ColorBatch();
  private staticBatch = new ColorBatch();
  private water: WaterModel | null = null;
  private dpr = 1;
  private qualityScale = 1;
  private cssWidth = 1;
  private cssHeight = 1;
  camera: Camera = { x: 0, y: 0, cssScale: 6 };
  private initializedCamera = false;
  private fpsWindowStart = 0;
  private fpsFrames = 0;
  private qualityCooldown = 0;
  fps = 60;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      desynchronized: true,
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;

    this.colorProgram = makeProgram(gl, COLOR_VS, COLOR_FS);
    this.waterProgram = makeProgram(gl, WATER_VS, WATER_FS);
    this.raftProgram = makeProgram(gl, RAFT_VS, RAFT_FS);
    this.circleProgram = makeProgram(gl, CIRCLE_VS, CIRCLE_FS);
    this.pointProgram = makeProgram(gl, POINT_VS, POINT_FS);

    this.colorVao = gl.createVertexArray()!;
    this.colorBuffer = gl.createBuffer()!;
    gl.bindVertexArray(this.colorVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, 1024 * 1024, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);

    this.raftVao = this.createInstancedQuadVao();
    this.raftBuffer = gl.createBuffer()!;
    gl.bindVertexArray(this.raftVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.raftBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, 64 * 10 * 4, gl.DYNAMIC_DRAW);
    const stride = 10 * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);

    this.pointVao = gl.createVertexArray()!;
    this.pointBuffer = gl.createBuffer()!;
    gl.bindVertexArray(this.pointVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, 2000 * 7 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 28, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 28, 12);

    this.resize();
  }

  private createInstancedQuadVao(): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  }

  resize() {
    const maxDpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const dpr = Math.max(0.75, maxDpr * this.qualityScale);
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.dpr = dpr;
    this.cssWidth = w;
    this.cssHeight = h;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.gl.viewport(0, 0, pw, ph);
    this.camera.cssScale = clamp(Math.min(w / 155, h / 105), 4.1, 7.4);
  }

  screenToWorld(clientX: number, clientY: number): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const s = this.camera.cssScale;
    return {
      x: this.camera.x + (x - this.cssWidth * 0.5) / s,
      y: this.camera.y + (y - this.cssHeight * 0.5) / s,
    };
  }

  setWater(water: WaterModel) {
    this.water = water;
    this.initializedCamera = false;
    this.buildWaterMesh();
    this.buildStaticProps();
    this.buildCircles();
  }

  private buildWaterMesh() {
    const gl = this.gl;
    const water = this.water!;
    const path = water.path;
    const rowStep = 4;
    const rows = Math.floor(path.length / rowStep);
    const cols = 16;
    const vertices: number[] = [];
    const indices: number[] = [];

    for (let r = 0; r <= rows; r++) {
      const s = Math.min(path.length, r * rowStep);
      const f = path.frameAt(s);
      for (let c = 0; c <= cols; c++) {
        const sideN = -1 + (2 * c) / cols;
        const lateral = sideN * f.width * 0.5;
        const p = { x: f.p.x + f.normal.x * lateral, y: f.p.y + f.normal.y * lateral };
        const flow = water.sampleSL(s, lateral, 0);
        vertices.push(p.x, p.y, sideN, flow.depth, flow.speed, flow.velocity.x, flow.velocity.y);
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = r * (cols + 1) + c;
        const b = a + 1;
        const d = (r + 1) * (cols + 1) + c;
        const e = d + 1;
        indices.push(a, d, b, b, d, e);
      }
    }

    this.waterVao = gl.createVertexArray();
    gl.bindVertexArray(this.waterVao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    const ebo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW);
    const stride = 7 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 2, gl.FLOAT, false, stride, 20);
    this.waterIndexCount = indices.length;
    gl.bindVertexArray(null);
  }

  private buildStaticProps() {
    const water = this.water!;
    const path = water.path;
    const b = this.staticBatch;
    b.clear();

    // Pebble/sand bank ribbon.
    const rows = Math.floor(path.length / 5);
    const cols = 8;
    const halfExtra = 17;
    const bankVerts: number[] = [];
    const bankIdx: number[] = [];
    for (let r = 0; r <= rows; r++) {
      const s = Math.min(path.length, r * 5);
      const f = path.frameAt(s);
      const half = f.width * 0.5 + halfExtra;
      for (let c = 0; c <= cols; c++) {
        const sideN = -1 + (2 * c) / cols;
        const lat = sideN * half;
        const p = { x: f.p.x + f.normal.x * lat, y: f.p.y + f.normal.y * lat };
        const wet = clamp((Math.abs(lat) - f.width * 0.5) / halfExtra, 0, 1);
        const n = 0.5 + 0.5 * Math.sin(s * 0.37 + c * 2.9);
        const rCol = 0.20 + wet * 0.18 + n * 0.035;
        const gCol = 0.25 + wet * 0.10 + n * 0.04;
        const bCol = 0.16 + wet * 0.08;
        bankVerts.push(p.x, p.y, rCol, gCol, bCol, 1);
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = r * (cols + 1) + c;
        const b0 = a + 1;
        const d = (r + 1) * (cols + 1) + c;
        const e = d + 1;
        bankIdx.push(a, d, b0, b0, d, e);
      }
    }
    const gl = this.gl;
    this.staticColorVao = gl.createVertexArray();
    gl.bindVertexArray(this.staticColorVao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const interleaved: number[] = [];
    for (let i = 0; i < bankVerts.length; i += 6) interleaved.push(...bankVerts.slice(i, i + 6));
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(interleaved), gl.STATIC_DRAW);
    const ebo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(bankIdx), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    this.staticColorCount = bankIdx.length;
    this.staticIsIndexed = true;
    gl.bindVertexArray(null);

    // Dock and launch platform are emitted into the same static batch afterwards.
    const dockS = path.dockS + 10;
    const f = path.frameAt(dockS);
    const dockSide = 1;
    const dockStart = {
      x: f.p.x + f.normal.x * dockSide * (f.width * 0.5 - 1),
      y: f.p.y + f.normal.y * dockSide * (f.width * 0.5 - 1),
    };
    const dockEnd = {
      x: f.p.x + f.normal.x * dockSide * (f.width * 0.5 + 15),
      y: f.p.y + f.normal.y * dockSide * (f.width * 0.5 + 15),
    };
    b.quad(dockStart.x, dockStart.y, dockEnd.x, dockEnd.y, 7.5, [0.43, 0.27, 0.13, 1]);
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const x = dockStart.x + (dockEnd.x - dockStart.x) * t;
      const y = dockStart.y + (dockEnd.y - dockStart.y) * t;
      b.quad(
        x - f.tangent.x * 3.6,
        y - f.tangent.y * 3.6,
        x + f.tangent.x * 3.6,
        y + f.tangent.y * 3.6,
        0.16,
        [0.20, 0.12, 0.06, 1],
      );
    }
    // Launch rack at the upstream end.
    const lf = path.frameAt(18);
    const lp = lf.p;
    b.quad(
      lp.x - lf.normal.x * 11,
      lp.y - lf.normal.y * 11,
      lp.x + lf.normal.x * 11,
      lp.y + lf.normal.y * 11,
      4.2,
      [0.38, 0.25, 0.13, 0.95],
    );
    this.uploadStaticBatch();
  }

  private staticIsIndexed = false;
  private staticBatchBuffer: WebGLBuffer | null = null;
  private staticBatchVao: WebGLVertexArrayObject | null = null;
  private staticBatchCount = 0;

  private uploadStaticBatch() {
    const gl = this.gl;
    if (!this.staticBatchVao) {
      this.staticBatchVao = gl.createVertexArray();
      this.staticBatchBuffer = gl.createBuffer();
    }
    this.staticBatchCount = this.staticBatch.data.length / 6;
    gl.bindVertexArray(this.staticBatchVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.staticBatchBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.staticBatch.data), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    gl.bindVertexArray(null);
  }

  private buildCircles() {
    const water = this.water!;
    const instances: number[] = [];
    for (const rock of water.stream.rocks) {
      const p = water.path.positionAt(rock.s, rock.lateral);
      instances.push(p.x, p.y, rock.radius, 0, 0.39, 0.40, 0.37, 1, rock.s * 0.13 + rock.radius);
    }
    // Deterministic trees on both banks.
    for (let s = 8; s < water.path.length - 20; s += 11) {
      for (const side of [-1, 1]) {
        const seed = Math.sin(s * 12.9898 + side * 78.233) * 43758.5453;
        const rnd = seed - Math.floor(seed);
        if (rnd < 0.28) continue;
        const f = water.path.frameAt(s + rnd * 7);
        const lat = side * (f.width * 0.5 + 5 + rnd * 18);
        const p = { x: f.p.x + f.normal.x * lat, y: f.p.y + f.normal.y * lat };
        const radius = 2.2 + rnd * 2.8;
        const green = 0.16 + rnd * 0.12;
        instances.push(p.x, p.y, radius, 0, 0.10 + rnd * 0.05, green, 0.12 + rnd * 0.05, 1, rnd * 20);
      }
    }
    this.circleCount = instances.length / 9;
    const gl = this.gl;
    this.circleVao = gl.createVertexArray();
    gl.bindVertexArray(this.circleVao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(instances), gl.STATIC_DRAW);
    const stride = 9 * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
  }

  private setCommonUniforms(program: WebGLProgram) {
    const gl = this.gl;
    gl.useProgram(program);
    gl.uniform2f(gl.getUniformLocation(program, 'uCam'), this.camera.x, this.camera.y);
    gl.uniform2f(gl.getUniformLocation(program, 'uRes'), this.canvas.width, this.canvas.height);
    gl.uniform1f(gl.getUniformLocation(program, 'uScale'), this.camera.cssScale * this.dpr);
  }

  private clear() {
    const gl = this.gl;
    gl.clearColor(0.055, 0.12, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  renderMap(time: number) {
    if (!this.water) return;
    this.resize();
    this.updateOverviewCamera();
    this.clear();
    this.drawWorld(time, null, false);
    this.drawMapMarkers(time);
  }

  renderAssembly(sim: RaftSimulation, time: number) {
    this.resize();
    const pts = sim.sections.map((_, i) => sim.sectionCenter(i));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    this.camera.x = (minX + maxX) / 2;
    this.camera.y = (minY + maxY) / 2;
    this.camera.cssScale = clamp(Math.min(this.cssWidth / 76, this.cssHeight / 18), 5, 18);
    this.clear();
    this.drawWorld(time, sim, false);
  }

  renderGame(sim: RaftSimulation, frameDt: number, time: number) {
    this.resize();
    this.updateFollowCamera(sim, frameDt);
    this.updateFps();
    this.clear();
    this.drawWorld(time, sim, false);
    this.drawGameTools(sim);
    this.drawParticles(sim);
  }

  private updateFps() {
    const now = performance.now();
    if (!this.fpsWindowStart) this.fpsWindowStart = now;
    this.fpsFrames++;
    const elapsed = now - this.fpsWindowStart;
    if (elapsed < 600) return;
    this.fps = Math.round((this.fpsFrames * 1000) / elapsed);
    this.fpsWindowStart = now;
    this.fpsFrames = 0;
    this.qualityCooldown -= elapsed / 1000;
    if (this.qualityCooldown <= 0) {
      if (this.fps < 54 && this.qualityScale > 0.62) {
        this.qualityScale = Math.max(0.62, this.qualityScale - 0.12);
        this.qualityCooldown = 1.4;
      } else if (this.fps >= 59 && this.qualityScale < 1) {
        this.qualityScale = Math.min(1, this.qualityScale + 0.04);
        this.qualityCooldown = 2;
      }
    }
  }

  private updateOverviewCamera() {
    const b = this.water!.path.bounds;
    this.camera.x = (b.minX + b.maxX) / 2;
    this.camera.y = (b.minY + b.maxY) / 2;
    const w = Math.max(1, b.maxX - b.minX + 55);
    const h = Math.max(1, b.maxY - b.minY + 55);
    this.camera.cssScale = clamp(Math.min(this.cssWidth / w, this.cssHeight / h), 0.35, 12);
  }

  private updateFollowCamera(sim: RaftSimulation, dt: number) {
    const head = sim.headCenter();
    const lookIndex = Math.min(sim.sections.length - 1, 15);
    const mid = sim.sectionCenter(lookIndex);
    const tail = sim.sectionCenter(sim.sections.length - 1);
    let tx = head.x * 0.48 + mid.x * 0.3 + tail.x * 0.22;
    let ty = head.y * 0.48 + mid.y * 0.3 + tail.y * 0.22;
    tx += sim.vx[0] * 0.45;
    ty += sim.vy[0] * 0.45;
    if (!this.initializedCamera) {
      this.camera.x = tx;
      this.camera.y = ty;
      this.initializedCamera = true;
    } else {
      const k = 1 - Math.exp(-3.2 * dt);
      this.camera.x += (tx - this.camera.x) * k;
      this.camera.y += (ty - this.camera.y) * k;
    }
    const shake = sim.sections.reduce((m, s) => Math.max(m, s.impact), 0);
    if (shake > 0.01) {
      this.camera.x += (Math.random() - 0.5) * shake * 1.4;
      this.camera.y += (Math.random() - 0.5) * shake * 1.4;
    }
  }

  private drawWorld(time: number, sim: RaftSimulation | null, assembly: boolean) {
    const gl = this.gl;
    if (!assembly) {
      // Indexed bank ribbon.
      if (this.staticColorVao && this.staticColorCount) {
        gl.bindVertexArray(this.staticColorVao);
        this.setCommonUniforms(this.colorProgram);
        gl.drawElements(gl.TRIANGLES, this.staticColorCount, gl.UNSIGNED_INT, 0);
      }
      // Static dock/launch colored batch.
      if (this.staticBatchVao && this.staticBatchCount) {
        gl.bindVertexArray(this.staticBatchVao);
        this.setCommonUniforms(this.colorProgram);
        gl.drawArrays(gl.TRIANGLES, 0, this.staticBatchCount);
      }
      this.drawWater(time);
      this.drawCircles();
    } else {
      gl.clearColor(0.075, 0.105, 0.085, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (sim) this.drawRaft(sim);
    gl.bindVertexArray(null);
  }

  private drawWater(time: number) {
    if (!this.waterVao || !this.water) return;
    const gl = this.gl;
    gl.useProgram(this.waterProgram);
    gl.uniform2f(gl.getUniformLocation(this.waterProgram, 'uCam'), this.camera.x, this.camera.y);
    gl.uniform2f(gl.getUniformLocation(this.waterProgram, 'uRes'), this.canvas.width, this.canvas.height);
    gl.uniform1f(gl.getUniformLocation(this.waterProgram, 'uScale'), this.camera.cssScale * this.dpr);
    gl.uniform1f(gl.getUniformLocation(this.waterProgram, 'uTime'), time);
    gl.uniform1f(gl.getUniformLocation(this.waterProgram, 'uRain'), this.water.weather.rain);
    gl.bindVertexArray(this.waterVao);
    gl.drawElements(gl.TRIANGLES, this.waterIndexCount, gl.UNSIGNED_INT, 0);
  }

  private drawCircles() {
    if (!this.circleVao) return;
    const gl = this.gl;
    this.setCommonUniforms(this.circleProgram);
    gl.bindVertexArray(this.circleVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.circleCount);
  }

  private drawRaft(sim: RaftSimulation) {
    const gl = this.gl;
    const data = new Float32Array(sim.config.sections * 10);
    for (let i = 0; i < sim.config.sections; i++) {
      const s = sim.sections[i];
      const cx = (sim.x[s.a] + sim.x[s.b]) * 0.5;
      const cy = (sim.y[s.a] + sim.y[s.b]) * 0.5;
      const o = i * 10;
      data[o] = cx;
      data[o + 1] = cy;
      data[o + 2] = s.angle;
      data[o + 3] = 1.66;
      data[o + 4] = 1.42 + sim.config.bamboosPerSection * 0.065;
      data[o + 5] = s.hp / 100;
      data[o + 6] = s.impact;
      data[o + 7] = clamp(s.grounded * 2.2, 0, 1);
      data[o + 8] = i + 1;
      data[o + 9] = sim.config.bamboosPerSection;
    }
    gl.bindVertexArray(this.raftVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.raftBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    this.setCommonUniforms(this.raftProgram);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, sim.config.sections);
  }

  private drawGameTools(sim: RaftSimulation) {
    const batch = this.dynamicBatch;
    batch.clear();

    // Vine connections.
    for (let i = 0; i < sim.joints.length; i++) {
      const j = sim.joints[i];
      const rear = i * 2 + 1;
      const nextFront = (i + 1) * 2;
      const x1 = sim.x[rear], y1 = sim.y[rear];
      const x2 = sim.x[nextFront], y2 = sim.y[nextFront];
      if (j.active) {
        const stress = clamp(j.stress, 0, 1);
        batch.quad(x1, y1, x2, y2, 0.16, [0.42 + stress * 0.45, 0.27 - stress * 0.12, 0.12, 1]);
      } else {
        const a = sim.sections[i];
        const b = sim.sections[i + 1];
        const ac = sim.sectionCenter(i);
        const bc = sim.sectionCenter(i + 1);
        batch.quad(x1, y1, x1 + Math.cos(a.angle) * 0.42, y1 + Math.sin(a.angle) * 0.42, 0.13, [0.25, 0.16, 0.08, 0.9]);
        batch.quad(x2, y2, x2 - Math.cos(b.angle) * 0.42, y2 - Math.sin(b.angle) * 0.42, 0.13, [0.25, 0.16, 0.08, 0.9]);
        void ac; void bc;
      }
    }

    // Pole and aim/charge indicator.
    const plan = sim.chargeHeld || sim.poleAnim > 0 ? sim.planPole(sim.aim) : sim.lastPole;
    if (plan) {
      const alpha = sim.chargeHeld ? 1 : clamp(sim.poleAnim, 0, 1);
      const power = sim.chargeHeld ? sim.charge : sim.polePower;
      const color: [number, number, number, number] = plan.valid
        ? [0.78, 0.58, 0.31, alpha]
        : [0.85, 0.25, 0.18, alpha * 0.8];
      batch.quad(plan.origin.x, plan.origin.y, plan.target.x, plan.target.y, 0.11, color);
      const ringColor: [number, number, number, number] = !plan.valid
        ? [1, 0.25, 0.18, 0.9]
        : power > 0.86
          ? [1, 0.28, 0.12, 0.95]
          : power > 0.55
            ? [1, 0.78, 0.2, 0.95]
            : [0.55, 1, 0.72, 0.9];
      batch.ring(plan.target.x, plan.target.y, 0.75 + power * 0.65, 0.12, ringColor);
      if (sim.chargeHeld) {
        const dirx = plan.origin.x - plan.target.x;
        const diry = plan.origin.y - plan.target.y;
        const l = Math.hypot(dirx, diry) || 1;
        const fx = plan.origin.x + (dirx / l) * (2 + power * 4);
        const fy = plan.origin.y + (diry / l) * (2 + power * 4);
        batch.quad(plan.origin.x, plan.origin.y, fx, fy, 0.18, [1, 0.92, 0.35, 0.9]);
      }
    }

    // Dock finish line.
    if (this.water) {
      const f = this.water.path.frameAt(this.water.path.dockS);
      const a = { x: f.p.x - f.normal.x * f.width * 0.52, y: f.p.y - f.normal.y * f.width * 0.52 };
      const b = { x: f.p.x + f.normal.x * f.width * 0.52, y: f.p.y + f.normal.y * f.width * 0.52 };
      batch.quad(a.x, a.y, b.x, b.y, 0.35, [0.95, 0.82, 0.32, 0.95]);
    }

    this.uploadAndDrawColor(this.dynamicBatch, this.colorVao, this.colorBuffer);
  }

  private drawMapMarkers(time: number) {
    if (!this.water) return;
    const batch = this.dynamicBatch;
    batch.clear();
    const start = this.water.path.positionAt(28, 0);
    const dock = this.water.path.positionAt(this.water.path.dockS, 0);
    const pulse = 1 + Math.sin(time * 3) * 0.18;
    batch.ring(start.x, start.y, 3.2 * pulse, 0.35, [0.55, 1, 0.62, 0.95]);
    batch.ring(dock.x, dock.y, 4.2 * pulse, 0.42, [1, 0.84, 0.28, 0.95]);
    // Route centre glint.
    for (let s = 20; s < this.water.path.length - 30; s += 24) {
      const p = this.water.path.positionAt(s + ((time * 18) % 24), 0);
      batch.ring(p.x, p.y, 0.7, 0.16, [0.8, 0.98, 1, 0.55], 14);
    }
    this.uploadAndDrawColor(batch, this.colorVao, this.colorBuffer);
  }

  private uploadAndDrawColor(batch: ColorBatch, vao: WebGLVertexArrayObject, buffer: WebGLBuffer) {
    const gl = this.gl;
    if (!batch.data.length) return;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(batch.data), gl.DYNAMIC_DRAW);
    this.setCommonUniforms(this.colorProgram);
    gl.drawArrays(gl.TRIANGLES, 0, batch.data.length / 6);
  }

  private drawParticles(sim: RaftSimulation) {
    if (!sim.splashes.length) return;
    const gl = this.gl;
    const data: number[] = [];
    for (const p of sim.splashes) {
      const a = clamp(p.life / p.maxLife, 0, 1);
      data.push(p.x, p.y, p.size * (1.4 - a * 0.4), 1, 1, 1, a);
    }
    gl.bindVertexArray(this.pointVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(data));
    this.setCommonUniforms(this.pointProgram);
    gl.drawArrays(gl.POINTS, 0, sim.splashes.length);
  }

  dispose() {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}
