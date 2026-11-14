// 3D-окно: сцена Three.js, жесты, выбор касанием, манипулятор, режим эскиза,
// кубик вида, перспектива/ортогональ, светлая/тёмная тема.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { Body, RefPlane, Sketch } from "./doc";
import { mesh, type Shape } from "./kernel";
import { closestOnSegment, dot, isClosed, outline, sub, toLocal, toWorld, type Profile, type SketchPlane, type V2, type Vec3 } from "./sketch";

const TAP_MAX_MOVE = 10; // px
const TAP_MAX_TIME = 450; // ms
const PALM_MS = 500; // ms — сколько после пера касания пальцем считаются ладонью
const GESTURE_MS = 350; // ms — касание несколькими пальцами для отмены/повтора
const GESTURE_MOVE = 14; // px — допустимое смещение пальцев в таком касании
const SNAP_RADIUS = 16; // px — радиус прилипания к точкам эскиза
const SNAP_STEPS = [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100];
const EDGE_PICK_PX = 16; // px — насколько близко к ребру нужно коснуться
const HL_COLOR = 0xffb02e;
const HOVER_COLOR = 0x5dd39e;
const VIEW_ANIM_MS = 350;
const CUBE_HALF = 30; // px — половина ребра кубика вида
const ISO_DIR: Vec3 = [0.5, -0.68, 0.53];
/** Больше стольких треугольников — тело тяжело отрисовывать и выбирать на планшете */
const HEAVY_TRIANGLES = 400_000;

export type PickMode = "body" | "face" | "edge" | "vertex";
export type Projection = "persp" | "ortho";

export type Pick =
  | { kind: "body"; id: number; faceId: number }
  | { kind: "face"; id: number; faceId: number }
  | { kind: "edge"; id: number; edgeId: number }
  | { kind: "profile"; sketchId: number; index: number }
  | { kind: "plane"; id: number }
  | { kind: "vertex"; id: number; at: Vec3 }
  | null;

export interface SubSelection {
  bodyId: number;
  faces: number[];
  edges: number[];
}

/** Размер в эскизе: линейный (между точками a и b) или диаметр окружности */
export type Dim =
  | { id: string; kind: "linear"; a: V2; b: V2; side: 1 | -1; text: string; editable: boolean; offset?: number }
  | { id: string; kind: "diameter"; c: V2; r: number; text: string; editable: boolean }
  /** Просто подпись в точке (значки связей эскиза) */
  | { id: string; kind: "label"; at: V2; text: string; editable: false };

type Groups = { start: number; count: number }[];

/** Что показать в черновике эскиза */
export interface DraftView {
  closed: Profile[];
  open: V2[][];
  marker: V2 | null;
  markerHot: boolean;
  dims?: Dim[];
  handles?: V2[];
  selected?: V2[];
  refLines?: [V2, V2][];
  /** Элемент под курсором/пером: точки и отрезки/кривые */
  hover?: { pts: V2[]; lines: V2[][] };
}

export type SketchEvent = "down" | "move" | "up" | "hover" | "cancel";

export interface ProfileRef {
  sketchId: number;
  index: number;
}

interface Palette {
  bg: number;
  grid: [number, number];
  sketchGrid: [number, number];
  draft: number;
  sketchLine: number;
  dim: number;
  edges: number;
}

const PALETTES: Record<"dark" | "light", Palette> = {
  dark: { bg: 0x1a1d23, grid: [0x4a505c, 0x2c3038], sketchGrid: [0x5a6170, 0x343943], draft: 0xffffff, sketchLine: 0x9fc0ff, dim: 0xc9d4e8, edges: 0x15171c },
  light: { bg: 0xdde3ea, grid: [0x9aa4b2, 0xc4cbd5], sketchGrid: [0x8a94a3, 0xbac2cd], draft: 0x1d2330, sketchLine: 0x2f5fc0, dim: 0x3a4456, edges: 0x2a2f38 },
};

/** Грани кубика вида: нормаль, «верх» надписи и подпись */
const CUBE_FACES: { n: Vec3; up: Vec3; label: string }[] = [
  { n: [0, 0, 1], up: [0, 1, 0], label: "Сверху" },
  { n: [0, 0, -1], up: [0, -1, 0], label: "Снизу" },
  { n: [0, -1, 0], up: [0, 0, 1], label: "Спереди" },
  { n: [0, 1, 0], up: [0, 0, 1], label: "Сзади" },
  { n: [1, 0, 0], up: [0, 0, 1], label: "Справа" },
  { n: [-1, 0, 0], up: [0, 0, 1], label: "Слева" },
];

const v3 = (a: Vec3) => new THREE.Vector3(...a);

/** Матрица, переводящая локальные координаты эскиза (u, v, 0) в мировые */
function planeMatrix(pl: SketchPlane, lift = 0) {
  const o = v3(pl.origin).addScaledVector(v3(pl.normal), lift);
  return new THREE.Matrix4().makeBasis(v3(pl.xDir), v3(pl.yDir), v3(pl.normal)).setPosition(o);
}

function makeGrid(size: number, divisions: number, [major, minor]: [number, number], opacity = 1) {
  const grid = new THREE.GridHelper(size, divisions, major, minor);
  grid.rotation.x = Math.PI / 2; // GridHelper лежит в XZ — кладём в XY
  const mat = grid.material as THREE.Material;
  mat.transparent = opacity < 1;
  mat.opacity = opacity;
  return grid;
}

export class Viewport {
  onTap: (pick: Pick) => void = () => {};
  onMoveEnd: (bodyId: number, delta: Vec3) => void = () => {};
  /**
   * p — точка с привязкой, raw — точно под пальцем (для попадания в ручки и линии),
   * snap — что сработало: подпись привязки («конец», «середина», «на ребре»…) или null
   */
  onSketch: (type: SketchEvent, p: V2, snappedToPoint: boolean, raw: V2, snap: string | null) => void = () => {};
  /** Наведение на тело в режиме «Тело» */
  hoverBody = false;
  onScaleEnd: (bodyId: number, factors: Vec3) => void = () => {};
  /** Тело получилось слишком детальным для сетки (предупреждение о пределах) */
  onHeavyMesh: (bodyName: string, triangles: number) => void = () => {};
  /** Ограничение масштаба по телу: свободно по осям, X=Y (цилиндр) или только равномерно */
  scaleRule: (bodyId: number) => "free" | "xy" | "uniform" = () => "uniform";
  onDimEdit: (id: string, label: HTMLElement) => void = () => {};
  onProjectionChange: (p: Projection) => void = () => {};
  /** Касание двумя (отмена) или тремя (повтор) пальцами */
  onGesture: (g: "undo" | "redo") => void = () => {};
  /** Вызывается каждый кадр после отрисовки (для позиционирования HTML поверх 3D) */
  onFrame: () => void = () => {};
  private penDown = false;
  private lastPenAt = -Infinity;
  /** На устройстве есть перо — палец больше не рисует в эскизе */
  private sawPen = false;
  /** Что выбирает касание по телу: тело целиком, грань или ребро */
  pickMode: PickMode = "body";
  /** Подсветка под курсором/стилусом (мышь, перо): грани, рёбра или ничего */
  hoverMode: "face" | "edge" | null = null;
  /** Какие грани можно подсвечивать (например, только плоские для эскиза) */
  hoverFilter: ((bodyId: number, faceId: number) => boolean) | null = null;
  /** Привязка к сетке: в эскизе и при перемещении манипулятором */
  gridSnap = true;
  /** Заблокированные тела обычно не выбираются; для выбора плоскости эскиза — можно */
  lockedPickable = false;
  /** Выделение рамкой: один палец/ЛКМ рисует прямоугольник вместо вращения */
  boxSelect = false;
  onBoxSelect: (bodyIds: number[], additive: boolean) => void = () => {};

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private persp: THREE.PerspectiveCamera;
  private ortho: THREE.OrthographicCamera;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private sun = new THREE.DirectionalLight(0xffffff, 1.6);
  private orbit: OrbitControls;
  private gizmo: TransformControls;
  private grid: THREE.Object3D;
  private bodiesRoot = new THREE.Group();
  private sketchRoot = new THREE.Group();
  private draftRoot = new THREE.Group();
  private previewRoot = new THREE.Group();
  private planeRoot = new THREE.Group();
  private planePreview = new THREE.Group();
  private boxEl: HTMLDivElement;
  /** Кэш построенных объектов: данные неизменяемы, поэтому ключ — сам объект */
  private cache = new WeakMap<Body, THREE.Group>();
  private sketchCache = new WeakMap<Sketch, THREE.Group>();
  private groups = new Map<number, THREE.Group>();
  private raycaster = new THREE.Raycaster();
  private gizmoBusy = false;
  private dragStart = new THREE.Vector3();
  private palette = PALETTES.dark;

  // режим эскиза
  private sketchPlane: SketchPlane | null = null;
  private sketchGrid: THREE.Object3D | null = null;
  private snapTargets: V2[] = [];
  private snapKinds: string[] = [];
  private snapLines: [V2, V2][] = [];
  private hoverBodyId: number | null = null;
  private cubeAxes!: SVGSVGElement;
  private dimLayer: HTMLDivElement;
  private dimLabels: { el: HTMLElement; at: THREE.Vector3 }[] = [];
  /** Подписи по id — переиспользуем, чтобы при движении мыши они не пересоздавались */
  private dimEls = new Map<string, HTMLElement>();
  private gizmoMode: "translate" | "scale" = "translate";
  private hiddenBodyId: number | null = null;

  // ручка вытягивания
  private handle = new THREE.Object3D();
  private handleState: { origin: Vec3; normal: Vec3; onChange: (d: number) => void } | null = null;

  // подсветка под курсором
  private hoverKey = "";
  private hoverQueued: { x: number; y: number } | null = null;

  // кубик вида и анимация камеры
  private cubeEl: HTMLDivElement;
  private cubeMatrix = "";
  private projBtn: HTMLButtonElement;
  private anim: { from: THREE.Vector3; q: THREE.Quaternion; t0: number; dist: number } | null = null;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(this.palette.bg);
    container.appendChild(this.renderer.domElement);

    // CAD-соглашение: ось Z смотрит вверх, единицы — миллиметры
    this.persp = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
    this.ortho = new THREE.OrthographicCamera(-100, 100, 100, -100, -1e5, 1e5);
    for (const c of [this.persp, this.ortho]) {
      c.up.set(0, 0, 1);
      c.position.set(140, -190, 130);
      this.scene.add(c);
    }
    this.camera = this.persp;
    this.sun.position.set(0.5, -0.4, 1);
    this.camera.add(this.sun);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404650, 1.6));

    this.grid = makeGrid(400, 40, this.palette.grid);
    this.scene.add(this.grid, this.axes(60));
    this.scene.add(this.bodiesRoot, this.sketchRoot, this.draftRoot, this.previewRoot, this.handle, this.planeRoot, this.planePreview);

    // Один палец — вращение, два — масштаб и сдвиг; мышь: ЛКМ вращение, ПКМ сдвиг
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.15;
    this.orbit.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.orbit.target.set(0, 0, 20);
    // Масштаб колесом/щипком — к точке под курсором, а не к центру экрана
    this.orbit.zoomToCursor = true;
    this.orbit.addEventListener("start", () => (this.anim = null));

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setMode("translate");
    this.gizmo.setSize(1.3);
    this.gizmo.setTranslationSnap(1);
    this.gizmo.addEventListener("dragging-changed", (e) => {
      const dragging = (e as unknown as { value: boolean }).value;
      this.orbit.enabled = !dragging;
      const obj = this.gizmo.object;
      if (!obj || obj === this.handle) {
        if (dragging) this.gizmoBusy = true;
        return;
      }
      if (dragging) {
        this.gizmoBusy = true;
        this.dragStart.copy(obj.position);
      } else if (this.gizmoMode === "scale") {
        const f = obj.scale.clone();
        obj.scale.set(1, 1, 1);
        if (Math.abs(f.x - 1) + Math.abs(f.y - 1) + Math.abs(f.z - 1) > 1e-6) this.onScaleEnd(obj.userData.bodyId, [f.x, f.y, f.z]);
      } else {
        const d = obj.position.clone().sub(this.dragStart);
        if (d.lengthSq() > 1e-9) this.onMoveEnd(obj.userData.bodyId, [d.x, d.y, d.z]);
      }
    });
    this.gizmo.addEventListener("objectChange", () => {
      const obj = this.gizmo.object;
      if (this.gizmoMode === "scale" && obj && obj !== this.handle) this.constrainScale(obj);
      const h = this.handleState;
      if (h && this.gizmo.object === this.handle) {
        const p = this.handle.position;
        h.onChange(dot(sub([p.x, p.y, p.z], h.origin), h.normal));
      }
    });
    this.scene.add(this.gizmo.getHelper());

    this.dimLayer = Object.assign(document.createElement("div"), { className: "dim-layer" });
    container.appendChild(this.dimLayer);
    this.boxEl = Object.assign(document.createElement("div"), { className: "box-select" });
    container.appendChild(this.boxEl);
    const vc = this.buildViewCube();
    this.cubeEl = vc.cube;
    this.projBtn = vc.proj;

    this.setupPointer();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private frame() {
    this.stepAnimation();
    this.orbit.update();
    if (this.hoverQueued) {
      this.hover(this.hoverQueued.x, this.hoverQueued.y);
      this.hoverQueued = null;
    }
    this.renderer.render(this.scene, this.camera);
    this.updateViewCube();
    this.updateDimLabels();
    this.onFrame();
  }

  private axes(len: number) {
    const g = new THREE.Group();
    const mk = (dir: Vec3, color: number) => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), v3(dir).multiplyScalar(len)]);
      g.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color })));
    };
    mk([1, 0, 0], 0xff5d5d);
    mk([0, 1, 0], 0x5dd39e);
    mk([0, 0, 1], 0x4c8dff);
    return g;
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    const halfH = (this.ortho.top - this.ortho.bottom) / 2;
    this.ortho.left = -halfH * (w / h);
    this.ortho.right = halfH * (w / h);
    this.ortho.updateProjectionMatrix();
  }

  private ndc(cx: number, cy: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  }

  // ---------- тема и проекция ----------

  setTheme(theme: "dark" | "light") {
    this.palette = PALETTES[theme];
    this.renderer.setClearColor(this.palette.bg);
    this.scene.remove(this.grid);
    this.grid = makeGrid(400, 40, this.palette.grid);
    this.grid.visible = !this.sketchPlane;
    this.scene.add(this.grid);
    // Эскизы и тела строятся с цветами темы — сбрасываем кэш
    this.sketchCache = new WeakMap();
    this.cache = new WeakMap();
    if (this.sketchPlane) this.buildSketchGrid(this.sketchPlane);
  }

  get projection(): Projection {
    return this.camera === this.ortho ? "ortho" : "persp";
  }

  /** Переключение перспектива ⇄ ортогональ с сохранением видимого масштаба */
  setProjection(p: Projection) {
    if (p === this.projection) return;
    const target = this.orbit.target;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    const dir = this.camera.position.clone().sub(target);
    if (p === "ortho") {
      const halfH = dir.length() * tanHalf;
      const aspect = this.persp.aspect;
      Object.assign(this.ortho, { top: halfH, bottom: -halfH, left: -halfH * aspect, right: halfH * aspect, zoom: 1 });
      this.ortho.position.copy(this.persp.position);
      this.ortho.quaternion.copy(this.persp.quaternion);
      this.ortho.updateProjectionMatrix();
      this.camera = this.ortho;
    } else {
      const halfH = (this.ortho.top - this.ortho.bottom) / 2 / this.ortho.zoom;
      this.persp.position.copy(target).addScaledVector(dir.normalize(), halfH / tanHalf);
      this.persp.quaternion.copy(this.ortho.quaternion);
      this.camera = this.persp;
    }
    this.camera.add(this.sun);
    this.orbit.object = this.camera;
    this.gizmo.camera = this.camera;
    this.projBtn.textContent = p === "ortho" ? "Орто" : "Персп.";
    this.projBtn.classList.toggle("on", p === "ortho");
  }

  setGridSnap(on: boolean) {
    this.gridSnap = on;
    this.gizmo.setTranslationSnap(on ? 1 : null);
    this.gizmo.setScaleSnap(on ? 0.05 : null);
  }

  // ---------- кубик вида ----------

  private buildViewCube() {
    const wrap = Object.assign(document.createElement("div"), { className: "viewcube" });
    const scene = Object.assign(document.createElement("div"), { className: "vc-scene" });
    const cube = Object.assign(document.createElement("div"), { className: "vc-cube" });
    const h = CUBE_HALF;
    for (const f of CUBE_FACES) {
      const face = Object.assign(document.createElement("button"), { className: "vc-face", textContent: f.label, title: f.label });
      // Локальные оси грани в мировых координатах: вправо = up × n, вниз = −up, наружу = n
      const r = new THREE.Vector3(...f.up).cross(v3(f.n));
      const u = f.up;
      const n = f.n;
      face.style.transform = `matrix3d(${r.x},${r.y},${r.z},0,${-u[0]},${-u[1]},${-u[2]},0,${n[0]},${n[1]},${n[2]},0,${n[0] * h},${n[1] * h},${n[2] * h},1)`;
      face.addEventListener("click", () => this.setView(f.n));
      cube.append(face);
    }
    scene.append(cube);
    // Оси X/Y/Z из угла кубика — SVG поверх, пересчитывается вместе с поворотом камеры
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "vc-axes");
    svg.setAttribute("viewBox", "-48 -48 96 96");
    for (const [axis, color] of [["X", "#ff5d5d"], ["Y", "#5dd39e"], ["Z", "#4c8dff"]]) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-width", "2.5");
      line.setAttribute("stroke-linecap", "round");
      line.dataset.axis = axis;
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("fill", color);
      text.textContent = axis;
      text.dataset.axis = axis;
      svg.append(line, text);
    }
    scene.append(svg);
    this.cubeAxes = svg;
    const buttons = Object.assign(document.createElement("div"), { className: "vc-buttons" });
    const home = Object.assign(document.createElement("button"), { textContent: "⌂", title: "Изометрия" });
    home.addEventListener("click", () => this.setView(ISO_DIR));
    const proj = Object.assign(document.createElement("button"), { textContent: "Персп.", title: "Перспектива / ортогональная проекция" });
    proj.addEventListener("click", () => {
      const p = this.projection === "ortho" ? "persp" : "ortho";
      this.setProjection(p);
      this.onProjectionChange(p);
    });
    buttons.append(home, proj);
    wrap.append(scene, buttons);
    this.container.appendChild(wrap);
    return { cube, proj };
  }

  /** Поворот кубика повторяет поворот камеры (мир → экран, ось Y экрана вниз) */
  private updateViewCube() {
    const e = this.camera.matrixWorldInverse.elements;
    const m = `matrix3d(${e[0]},${-e[1]},${e[2]},0,${e[4]},${-e[5]},${e[6]},0,${e[8]},${-e[9]},${e[10]},0,0,0,0,1)`;
    if (m !== this.cubeMatrix) {
      this.cubeMatrix = m;
      this.cubeEl.style.transform = m;
      // Проекция мировых осей в экран кубика: x вправо, y вниз
      const h = CUBE_HALF;
      const proj = (x: number, y: number, z: number) => [e[0] * x + e[4] * y + e[8] * z, -(e[1] * x + e[5] * y + e[9] * z)];
      const [ox, oy] = proj(-h, -h, -h);
      const len = h * 2.4;
      const dirs: Record<string, [number, number, number]> = { X: [len, 0, 0], Y: [0, len, 0], Z: [0, 0, len] };
      for (const el of Array.from(this.cubeAxes.children) as SVGElement[]) {
        const d = dirs[el.dataset.axis!];
        const [tx, ty] = proj(-h + d[0], -h + d[1], -h + d[2]);
        if (el.tagName === "line") {
          el.setAttribute("x1", String(ox));
          el.setAttribute("y1", String(oy));
          el.setAttribute("x2", String(tx));
          el.setAttribute("y2", String(ty));
        } else {
          el.setAttribute("x", String(tx + (tx - ox) * 0.12 - 3));
          el.setAttribute("y", String(ty + (ty - oy) * 0.12 + 4));
        }
      }
    }
  }

  /** Плавно повернуть камеру так, чтобы она смотрела вдоль −dir на цель */
  setView(dir: Vec3) {
    const to = v3(dir).normalize();
    // Взгляд строго вдоль оси Z вырожден для камеры с up = Z — чуть наклоняем
    if (Math.abs(to.z) > 0.999) to.y -= Math.sign(to.z) * 1e-3;
    to.normalize();
    const offset = this.camera.position.clone().sub(this.orbit.target);
    const from = offset.clone().normalize();
    this.anim = { from, q: new THREE.Quaternion().setFromUnitVectors(from, to), t0: performance.now(), dist: offset.length() };
  }

  private stepAnimation() {
    const a = this.anim;
    if (!a) return;
    const t = Math.min(1, (performance.now() - a.t0) / VIEW_ANIM_MS);
    const k = 1 - Math.pow(1 - t, 3);
    const q = new THREE.Quaternion().slerp(a.q, k);
    const dir = a.from.clone().applyQuaternion(q);
    this.camera.position.copy(this.orbit.target).addScaledVector(dir, a.dist);
    if (t >= 1) this.anim = null;
  }

  // ---------- указатель ----------

  /**
   * Касания и перо.
   * - Ладонь: касания пальцем, пока перо у экрана (или в течение PALM_MS после), игнорируются.
   * - Если перо хоть раз использовалось, в эскизе рисует только перо, а палец двигает вид.
   * - Касание двумя/тремя пальцами без движения — отмена/повтор.
   * - Вне эскиза короткое касание без движения = выбор, остальное — жест камеры;
   *   вращение идёт вокруг точки модели под пальцем.
   */
  private setupPointer() {
    const el = this.renderer.domElement;
    const downs = new Map<number, { x: number; y: number; t: number }>();
    const ignored = new Set<number>();
    let multiTouch = false;
    let box: { x: number; y: number } | null = null;
    // Жест «касание несколькими пальцами»: сколько пальцев было и сдвигались ли они
    let tap: { t0: number; max: number; moved: boolean; starts: Map<number, [number, number]> } | null = null;

    const swallow = (e: PointerEvent) => {
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    // capture: сработать раньше OrbitControls и манипулятора
    el.addEventListener(
      "pointerdown",
      (e) => {
        if (e.pointerType === "pen") {
          this.penDown = true;
          this.lastPenAt = performance.now();
          if (!this.sawPen) {
            this.sawPen = true;
            this.updateTouchMap();
          }
        }
        if (e.pointerType === "touch" && (this.penDown || performance.now() - this.lastPenAt < PALM_MS)) {
          ignored.add(e.pointerId);
          return swallow(e);
        }
        if (e.pointerType === "touch") {
          if (!tap) tap = { t0: performance.now(), max: 0, moved: false, starts: new Map() };
          tap.starts.set(e.pointerId, [e.clientX, e.clientY]);
          tap.max = Math.max(tap.max, tap.starts.size);
        }
        downs.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
        if (downs.size > 1) {
          if (!multiTouch && this.sketchPlane) this.emitSketch("cancel", e);
          multiTouch = true;
        }
        if (downs.size === 1) this.gizmoBusy = false;
        // В эскизе рисует перо/мышь; палец — только если пера на устройстве не было
        const draws = !(e.pointerType === "touch" && this.sawPen);
        if (this.sketchPlane && downs.size === 1 && e.button === 0 && draws) this.emitSketch("down", e);
        box = !this.sketchPlane && this.boxSelect && downs.size === 1 && e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
        if (downs.size > 1) this.boxEl.style.display = "none";
        // Вращение вокруг точки модели под пальцем/курсором
        const rotates = e.pointerType === "touch" || (e.pointerType === "mouse" && e.button === 0);
        if (!this.sketchPlane && !this.boxSelect && downs.size === 1 && rotates) this.pivotAt(e.clientX, e.clientY);
      },
      { capture: true },
    );
    el.addEventListener(
      "pointermove",
      (e) => {
        if (e.pointerType === "pen") this.lastPenAt = performance.now();
        if (ignored.has(e.pointerId)) return swallow(e);
        const s = tap?.starts.get(e.pointerId);
        if (tap && s && Math.hypot(e.clientX - s[0], e.clientY - s[1]) > GESTURE_MOVE) tap.moved = true;
      },
      { capture: true },
    );
    el.addEventListener("pointermove", (e) => {
      if (this.sketchPlane) {
        if (multiTouch) return;
        const draws = !(e.pointerType === "touch" && this.sawPen);
        if (downs.has(e.pointerId) && draws) this.emitSketch("move", e);
        else if (e.pointerType !== "touch") this.emitSketch("hover", e);
        return;
      }
      if (box && downs.has(e.pointerId) && !multiTouch && !this.gizmoBusy) {
        const r = this.renderer.domElement.getBoundingClientRect();
        const [x0, x1] = [Math.min(box.x, e.clientX), Math.max(box.x, e.clientX)];
        const [y0, y1] = [Math.min(box.y, e.clientY), Math.max(box.y, e.clientY)];
        Object.assign(this.boxEl.style, { display: "block", left: x0 - r.left + "px", top: y0 - r.top + "px", width: x1 - x0 + "px", height: y1 - y0 + "px" });
        return;
      }
      // Мышь или перо без нажатия — подсветка того, что окажется под касанием
      if (e.pointerType !== "touch" && e.buttons === 0) this.hoverQueued = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener("pointerleave", () => this.clearHover());

    const endTap = (e: PointerEvent) => {
      if (!tap || e.pointerType !== "touch") return;
      tap.starts.delete(e.pointerId);
      if (tap.starts.size) return;
      const quick = performance.now() - tap.t0 < GESTURE_MS;
      if (quick && !tap.moved && (tap.max === 2 || tap.max === 3)) this.onGesture(tap.max === 2 ? "undo" : "redo");
      tap = null;
    };
    el.addEventListener(
      "pointerup",
      (e) => {
        if (e.pointerType === "pen") {
          this.penDown = false;
          this.lastPenAt = performance.now();
        }
        if (ignored.delete(e.pointerId)) return swallow(e);
        endTap(e);
      },
      { capture: true },
    );
    const up = (e: PointerEvent) => {
      const d = downs.get(e.pointerId);
      downs.delete(e.pointerId);
      const wasMulti = multiTouch;
      if (downs.size === 0) multiTouch = false;
      if (!d || wasMulti || e.button > 0) return;
      if (this.sketchPlane) {
        if (e.pointerType === "touch" && this.sawPen) return;
        return this.emitSketch("up", e);
      }
      if (this.gizmoBusy) return;
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (box && moved > TAP_MAX_MOVE) {
        this.boxEl.style.display = "none";
        const start = box;
        box = null;
        return this.onBoxSelect(this.bodiesInRect(start.x, start.y, e.clientX, e.clientY), e.shiftKey || e.ctrlKey || e.metaKey);
      }
      box = null;
      this.boxEl.style.display = "none";
      if (moved > TAP_MAX_MOVE || performance.now() - d.t > TAP_MAX_TIME) return;
      this.onTap(this.pick(e.clientX, e.clientY));
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", (e) => {
      if (e.pointerType === "pen") this.penDown = false;
      ignored.delete(e.pointerId);
      downs.delete(e.pointerId);
      tap = null;
      if (downs.size === 0) multiTouch = false;
    });
  }

  /**
   * Центр вращения — на глубине точки модели под пальцем. Цель сдвигается вдоль
   * линии взгляда, поэтому вид не дёргается, а модель вращается «вокруг себя».
   */
  private pivotAt(cx: number, cy: number) {
    this.raycaster.setFromCamera(this.ndc(cx, cy), this.camera);
    const hit = this.raycaster.intersectObjects([...this.groups.values()].map((g) => g.children[0]), false)[0];
    if (!hit) return;
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    const depth = hit.point.clone().sub(this.camera.position).dot(fwd);
    if (depth > 0) this.orbit.target.copy(this.camera.position).addScaledVector(fwd, depth);
  }

  /** Один палец в эскизе: при наличии пера — сдвиг вида, иначе ничего (рисует палец) */
  private updateTouchMap() {
    this.orbit.touches.ONE = this.sketchPlane && this.sawPen ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
  }

  /** Экранная точка (px от левого верхнего угла 3D-окна) для мировой точки */
  screenOf(p: Vec3): { x: number; y: number; visible: boolean } {
    const v = v3(p).project(this.camera);
    const el = this.renderer.domElement;
    return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight, visible: v.z < 1 && Math.abs(v.x) <= 1.2 && Math.abs(v.y) <= 1.2 };
  }

  private pick(cx: number, cy: number, mode: PickMode = this.pickMode, withProfiles = true): Pick {
    this.raycaster.setFromCamera(this.ndc(cx, cy), this.camera);
    const meshes = [...this.groups.values()].filter((g) => this.lockedPickable || !g.userData.locked).map((g) => g.children[0]);
    const bodyHit = this.raycaster.intersectObjects(meshes, false)[0];
    if (mode === "vertex") return this.pickVertex(cx, cy, bodyHit?.distance ?? Infinity);
    if (withProfiles) {
      const fills = this.sketchRoot.children.flatMap((g) => g.children.filter((c) => c.userData.fill));
      const profHit = this.raycaster.intersectObjects(fills, false)[0];
      // Профиль лежит на грани тела — при равных расстояниях выигрывает профиль
      if (profHit && (!bodyHit || profHit.distance <= bodyHit.distance + 0.5)) {
        const { sketchId, index } = profHit.object.userData;
        return { kind: "profile", sketchId, index };
      }
    }
    if (mode === "edge") return this.pickEdge(cx, cy, bodyHit?.distance ?? Infinity);
    if (!bodyHit) {
      // Вспомогательные плоскости выбираются, только если луч не попал в тело
      const fills = this.planeRoot.children.flatMap((g) => g.children.filter((c) => c.userData.fill));
      const ph = withProfiles ? this.raycaster.intersectObjects(fills, false)[0] : undefined;
      return ph ? { kind: "plane", id: ph.object.userData.planeId } : null;
    }
    const g = bodyHit.object.parent!;
    const tri = (bodyHit.faceIndex ?? 0) * 3;
    const fg = (g.userData.faceGroups as { start: number; count: number; faceId: number }[]).find(
      (f) => tri >= f.start && tri < f.start + f.count,
    );
    return { kind: mode === "face" ? "face" : "body", id: g.userData.bodyId, faceId: fg?.faceId ?? -1 };
  }

  /**
   * Ребро ищем в экранных координатах: ближайший к пальцу отрезок в пределах
   * EDGE_PICK_PX, не закрытый поверхностью (не дальше точки попадания луча в тело).
   */
  private pickEdge(cx: number, cy: number, surfaceDist: number): Pick {
    const r = this.renderer.domElement.getBoundingClientRect();
    const px = cx - r.left;
    const py = cy - r.top;
    const origin = this.raycaster.ray.origin;
    const toScreen = (v: THREE.Vector3) => {
      const p = v.clone().project(this.camera);
      return { x: ((p.x + 1) / 2) * r.width, y: ((1 - p.y) / 2) * r.height, z: p.z };
    };
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    let best: Pick = null;
    let bestD = EDGE_PICK_PX;
    for (const [id, g] of this.groups) {
      if (g.userData.locked && !this.lockedPickable) continue;
      const pos = (g.children[1] as THREE.LineSegments).geometry.getAttribute("position");
      for (const eg of g.userData.edgeGroups as { start: number; count: number; edgeId: number }[]) {
        for (let i = eg.start; i + 1 < eg.start + eg.count; i += 2) {
          a.fromBufferAttribute(pos, i).add(g.position);
          b.fromBufferAttribute(pos, i + 1).add(g.position);
          const sa = toScreen(a);
          const sb = toScreen(b);
          if (sa.z > 1 || sb.z > 1) continue; // за камерой
          const dx = sb.x - sa.x;
          const dy = sb.y - sa.y;
          const len2 = dx * dx + dy * dy;
          const t = len2 ? Math.min(1, Math.max(0, ((px - sa.x) * dx + (py - sa.y) * dy) / len2)) : 0;
          const d = Math.hypot(sa.x + t * dx - px, sa.y + t * dy - py);
          if (d >= bestD) continue;
          // Расстояние от начала луча — так проверка работает и в ортогональной проекции
          const w = a.clone().lerp(b, t);
          if (w.distanceTo(origin) > surfaceDist * 1.01 + 0.5) continue; // скрыто телом
          best = { kind: "edge", id, edgeId: eg.edgeId };
          bestD = d;
        }
      }
    }
    return best;
  }

  /** Вершина тела (конец ребра) ближе всего к пальцу, не закрытая поверхностью */
  private pickVertex(cx: number, cy: number, surfaceDist: number): Pick {
    const r = this.renderer.domElement.getBoundingClientRect();
    const origin = this.raycaster.ray.origin;
    const v = new THREE.Vector3();
    let best: Pick = null;
    let bestD = EDGE_PICK_PX * 1.3;
    for (const [id, g] of this.groups) {
      const pos = (g.children[1] as THREE.LineSegments).geometry.getAttribute("position");
      for (const eg of g.userData.edgeGroups as { start: number; count: number }[]) {
        for (const i of [eg.start, eg.start + eg.count - 1]) {
          v.fromBufferAttribute(pos, i).add(g.position);
          const p = v.clone().project(this.camera);
          if (p.z > 1) continue;
          const d = Math.hypot(((p.x + 1) / 2) * r.width - (cx - r.left), ((1 - p.y) / 2) * r.height - (cy - r.top));
          if (d >= bestD || v.distanceTo(origin) > surfaceDist * 1.01 + 0.5) continue;
          best = { kind: "vertex", id, at: [v.x, v.y, v.z] };
          bestD = d;
        }
      }
    }
    return best;
  }

  /** Тела, центр рамки которых попал в экранный прямоугольник */
  private bodiesInRect(x0: number, y0: number, x1: number, y1: number): number[] {
    const r = this.renderer.domElement.getBoundingClientRect();
    const [l, rt] = [Math.min(x0, x1) - r.left, Math.max(x0, x1) - r.left];
    const [t, b] = [Math.min(y0, y1) - r.top, Math.max(y0, y1) - r.top];
    const ids: number[] = [];
    for (const [id, g] of this.groups) {
      if (g.userData.locked) continue;
      const p = (g.userData.center as THREE.Vector3).clone().project(this.camera);
      const x = ((p.x + 1) / 2) * r.width;
      const y = ((1 - p.y) / 2) * r.height;
      if (x >= l && x <= rt && y >= t && y <= b) ids.push(id);
    }
    return ids;
  }

  setBoxSelect(on: boolean) {
    this.boxSelect = on;
    this.orbit.enableRotate = !on && !this.sketchPlane;
  }

  private buildPlane(pl: SketchPlane, color: number, opacity: number, size = 120) {
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;
    g.matrix.copy(planeMatrix(pl));
    const h = size / 2;
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }),
    );
    const corners = [new THREE.Vector3(-h, -h, 0), new THREE.Vector3(h, -h, 0), new THREE.Vector3(h, h, 0), new THREE.Vector3(-h, h, 0)];
    const border = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({ color }));
    g.add(fill, border);
    return g;
  }

  /** Предпросмотр создаваемой плоскости */
  setPlanePreview(pl: SketchPlane | null) {
    this.planePreview.clear();
    if (pl) this.planePreview.add(this.buildPlane(pl, 0xffb02e, 0.22));
  }

  // ---------- подсветка ----------

  /** Оверлей граней/рёбер тела поверх его меша; tag — метка для последующего удаления */
  private overlay(g: THREE.Group, faces: number[], edges: number[], color: number, tag: "hl" | "hover") {
    const src = (g.children[0] as THREE.Mesh).geometry;
    const index = src.getIndex()!.array;
    const fg = (g.userData.faceGroups as (Groups[number] & { faceId: number })[]).filter((f) => faces.includes(f.faceId));
    if (fg.length) {
      const idx: number[] = [];
      for (const f of fg) for (let i = f.start; i < f.start + f.count; i++) idx.push(index[i]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", src.getAttribute("position"));
      geo.setIndex(idx);
      const m = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: tag === "hl" ? 0.6 : 0.4,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        }),
      );
      m.userData[tag] = true;
      g.add(m);
    }
    const eg = (g.userData.edgeGroups as (Groups[number] & { edgeId: number })[]).filter((e) => edges.includes(e.edgeId));
    if (eg.length) {
      const pos = (g.children[1] as THREE.LineSegments).geometry.getAttribute("position").array;
      const pts: number[] = [];
      for (const e of eg) for (let i = e.start * 3; i < (e.start + e.count) * 3; i++) pts.push(pos[i]);
      const line = new LineSegments2(new LineSegmentsGeometry().setPositions(pts), new LineMaterial({ color, linewidth: tag === "hl" ? 5 : 4, depthTest: false }));
      line.userData[tag] = true;
      line.renderOrder = 2;
      g.add(line);
    }
  }

  private removeTagged(tag: "hl" | "hover") {
    for (const g of this.groups.values()) g.children.filter((c) => c.userData[tag]).forEach((c) => g.remove(c));
  }

  /** Подсветка выбранных граней и рёбер одного тела */
  setHighlight(sub: SubSelection | null) {
    this.removeTagged("hl");
    const g = sub && this.groups.get(sub.bodyId);
    if (sub && g) this.overlay(g, sub.faces, sub.edges, HL_COLOR, "hl");
  }

  /** Подсветка тела под курсором: лёгкое свечение материала (выбранные не трогаем) */
  private hoverBodyAt(cx: number, cy: number) {
    const p = this.pick(cx, cy, "body", false);
    const id = p?.kind === "body" ? p.id : null;
    if (id === this.hoverBodyId) return;
    const set = (bid: number | null, on: boolean) => {
      const g = bid !== null ? this.groups.get(bid) : undefined;
      if (!g) return;
      const mat = (g.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
      if (on) {
        if (mat.emissiveIntensity > 0) return; // выбранное тело уже подсвечено
        g.userData.hoverTint = true;
        mat.emissive.set(0x4fd1e8);
        mat.emissiveIntensity = 0.18;
      } else if (g.userData.hoverTint) {
        g.userData.hoverTint = false;
        mat.emissive.set(0x000000);
        mat.emissiveIntensity = 0;
      }
    };
    set(this.hoverBodyId, false);
    set(id, true);
    this.hoverBodyId = id;
    this.renderer.domElement.style.cursor = id !== null ? "pointer" : "";
  }

  private hover(cx: number, cy: number) {
    if (this.hoverBody && !this.hoverMode && !this.gizmo.dragging) return this.hoverBodyAt(cx, cy);
    if (!this.hoverMode || this.gizmo.dragging) return this.clearHover();
    const p = this.pick(cx, cy, this.hoverMode, false);
    let key = "";
    if (p?.kind === "face" && (!this.hoverFilter || this.hoverFilter(p.id, p.faceId))) key = `f:${p.id}:${p.faceId}`;
    if (p?.kind === "edge") key = `e:${p.id}:${p.edgeId}`;
    if (key === this.hoverKey) return;
    this.removeTagged("hover");
    this.hoverKey = key;
    this.renderer.domElement.style.cursor = key ? "pointer" : "";
    if (!key || !p || (p.kind !== "face" && p.kind !== "edge")) return;
    const g = this.groups.get(p.id)!;
    if (p.kind === "face") this.overlay(g, [p.faceId], [], HOVER_COLOR, "hover");
    else this.overlay(g, [], [p.edgeId], HOVER_COLOR, "hover");
  }

  clearHover() {
    if (!this.hoverKey) return;
    this.removeTagged("hover");
    this.hoverKey = "";
    this.renderer.domElement.style.cursor = "";
  }

  // ---------- построение сцены ----------

  private build(body: Body): THREE.Group {
    const m = mesh(body.shape);
    if (m.triangles.length / 3 > HEAVY_TRIANGLES) this.onHeavyMesh(body.name, m.triangles.length / 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(m.vertices, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(m.triangles, 1));
    geo.computeBoundingBox();
    // Геометрию центрируем, а группу ставим в центр — тогда манипулятор
    // появляется посреди тела, а не в начале координат
    const c = geo.boundingBox!.getCenter(new THREE.Vector3());
    geo.translate(-c.x, -c.y, -c.z);

    const mat = new THREE.MeshStandardMaterial({
      color: body.color,
      roughness: 0.55,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(m.edges, 3));
    edgeGeo.translate(-c.x, -c.y, -c.z);
    const edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: this.palette.edges }));

    const g = new THREE.Group();
    g.add(new THREE.Mesh(geo, mat), edges);
    g.position.copy(c);
    g.userData = { bodyId: body.id, center: c.clone(), faceGroups: m.faceGroups, edgeGroups: m.edgeGroups };
    return g;
  }

  /** Незамкнутая линия; ось — штрихпунктиром */
  private openLine(pts: V2[], color: number, dashed: boolean, overlay = false) {
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x, y, 0)));
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 6, gapSize: 3, depthTest: !overlay })
      : new THREE.LineBasicMaterial({ color, depthTest: !overlay });
    const line = new THREE.Line(geo, mat);
    if (dashed) line.computeLineDistances();
    if (overlay) line.renderOrder = 2;
    return line;
  }

  private buildSketch(sk: Sketch): THREE.Group {
    const g = new THREE.Group();
    sk.profiles.forEach((p, index) => {
      const pts = outline(p).map(([x, y]) => new THREE.Vector2(x, y));
      if (!isClosed(p)) {
        const ln = this.openLine(pts.map((q) => [q.x, q.y] as V2), this.palette.sketchLine, p.kind === "axis");
        ln.matrixAutoUpdate = false;
        ln.matrix.copy(planeMatrix(sk.plane, 0.06));
        g.add(ln);
        return;
      }
      // Заливка чуть приподнята над плоскостью, чтобы не мерцать на грани тела
      const fill = new THREE.Mesh(
        new THREE.ShapeGeometry(new THREE.Shape(pts)),
        new THREE.MeshBasicMaterial({ color: 0x4c8dff, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
      );
      fill.matrixAutoUpdate = false;
      fill.matrix.copy(planeMatrix(sk.plane, 0.05));
      fill.userData = { fill: true, sketchId: sk.id, index };
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: this.palette.sketchLine }));
      line.matrixAutoUpdate = false;
      line.matrix.copy(planeMatrix(sk.plane, 0.06));
      g.add(fill, line);
    });
    return g;
  }

  sync(
    bodies: Body[],
    selection: number[],
    sketches: Sketch[] = [],
    selProfile: ProfileRef | null = null,
    hideSketchId?: number,
    planes: RefPlane[] = [],
    selPlaneId: number | null = null,
  ) {
    this.planeRoot.clear();
    for (const rp of planes) {
      const sel = rp.id === selPlaneId;
      const g = this.buildPlane(rp.plane, sel ? 0xffb02e : 0x5b95ff, sel ? 0.25 : 0.1);
      g.children[0].userData = { fill: true, planeId: rp.id };
      this.planeRoot.add(g);
    }
    this.removeTagged("hover");
    this.hoverKey = "";
    this.groups.clear();
    this.bodiesRoot.clear();
    for (const b of bodies) {
      let g = this.cache.get(b);
      if (!g) {
        g = this.build(b);
        this.cache.set(b, g);
      }
      g.position.copy(g.userData.center);
      const mat = (g.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
      const order = selection.indexOf(b.id);
      mat.emissive.set(order === 0 ? 0x3a5fc0 : order > 0 ? 0x8a5a00 : 0x000000);
      mat.emissiveIntensity = order >= 0 ? 0.55 : 0;
      g.visible = b.id !== this.hiddenBodyId;
      g.userData.locked = !!b.locked;
      this.bodiesRoot.add(g);
      this.groups.set(b.id, g);
    }

    this.sketchRoot.clear();
    for (const sk of sketches) {
      if (sk.id === hideSketchId) continue;
      let g = this.sketchCache.get(sk);
      if (!g) {
        g = this.buildSketch(sk);
        this.sketchCache.set(sk, g);
      }
      g.children.forEach((c) => {
        if (!c.userData.fill) return;
        const sel = selProfile?.sketchId === sk.id && selProfile.index === c.userData.index;
        const mat = (c as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.color.set(sel ? 0xffb02e : 0x4c8dff);
        mat.opacity = sel ? 0.45 : 0.18;
      });
      this.sketchRoot.add(g);
    }

    this.applyXray();
    this.hoverBodyId = null;
    if (this.handleState) return;
    const single = selection.length === 1 ? this.groups.get(selection[0]) : undefined;
    this.gizmo.showX = this.gizmo.showY = true;
    this.gizmo.space = "world";
    this.gizmo.setMode(this.gizmoMode);
    if (single) this.gizmo.attach(single);
    else this.gizmo.detach();
  }

  centerOf(bodyId: number): Vec3 | undefined {
    const c = this.groups.get(bodyId)?.userData.center as THREE.Vector3 | undefined;
    return c ? [c.x, c.y, c.z] : undefined;
  }

  fit() {
    this.anim = null;
    const box = new THREE.Box3();
    this.groups.forEach((g) => box.expandByObject(g));
    box.expandByObject(this.sketchRoot);
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 50));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    const dist = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2))) * 1.15;
    this.orbit.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    if (this.camera === this.ortho) {
      this.ortho.zoom = (this.ortho.top - this.ortho.bottom) / (2 * sphere.radius * 1.15);
      this.ortho.updateProjectionMatrix();
    }
  }

  // ---------- режим эскиза ----------

  private buildSketchGrid(pl: SketchPlane) {
    if (this.sketchGrid) this.scene.remove(this.sketchGrid);
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(planeMatrix(pl, 0.02));
    holder.add(makeGrid(400, 80, this.palette.sketchGrid, 0.7));
    this.sketchGrid = holder;
    this.scene.add(holder);
  }

  enterSketch(pl: SketchPlane) {
    this.sketchPlane = pl;
    this.anim = null;
    this.clearHover();
    this.gizmo.detach();
    this.orbit.enableRotate = false;
    this.updateTouchMap();
    // Камера смотрит прямо на плоскость; крошечный сдвиг вниз по Y эскиза
    // убирает вырожденный случай «взгляд параллелен оси up» для горизонтальных плоскостей
    const dist = Math.max(this.camera.position.distanceTo(this.orbit.target), 150);
    const o = v3(pl.origin);
    this.orbit.target.copy(o);
    this.camera.position.copy(o).addScaledVector(v3(pl.normal), dist).addScaledVector(v3(pl.yDir), -dist * 1e-3);
    // Общая сетка в плоскости XY совпала бы с сеткой эскиза со сдвигом — получалась «двойная» сетка
    this.grid.visible = false;
    this.buildSketchGrid(pl);
    this.applyXray();
  }

  /** В эскизе тела полупрозрачны — эскиз внутри тела виден насквозь */
  private applyXray() {
    const on = !!this.sketchPlane;
    for (const g of this.groups.values()) {
      const mat = (g.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
      if (mat.transparent === on && mat.opacity === (on ? 0.3 : 1)) continue;
      mat.transparent = on;
      mat.opacity = on ? 0.3 : 1;
      mat.depthWrite = !on;
      mat.needsUpdate = true;
    }
  }

  exitSketch() {
    this.sketchPlane = null;
    this.applyXray();
    this.orbit.enableRotate = !this.boxSelect;
    this.updateTouchMap();
    if (this.sketchGrid) this.scene.remove(this.sketchGrid);
    this.sketchGrid = null;
    this.grid.visible = true;
    this.draftRoot.clear();
    this.setDimLabels([]);
  }

  /** Точки привязки и (необязательно) их подписи; линии — привязка «на линии/ребре» */
  setSnapTargets(pts: V2[], kinds: string[] = [], lines: [V2, V2][] = []) {
    this.snapTargets = pts;
    this.snapKinds = kinds;
    this.snapLines = lines;
  }

  /** Размер мирового миллиметра в пикселях (на расстоянии цели) */
  pxPerUnit() {
    const hPx = this.renderer.domElement.clientHeight;
    if (this.camera === this.ortho) return (hPx * this.ortho.zoom) / (this.ortho.top - this.ortho.bottom);
    const d = this.camera.position.distanceTo(this.orbit.target);
    return hPx / (2 * d * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)));
  }

  /** Шаг сетки привязки: наименьший «круглый» шаг не мельче ~12 px */
  snapStep() {
    const ppu = this.pxPerUnit();
    return SNAP_STEPS.find((s) => s * ppu >= 12) ?? 100;
  }

  private emitSketch(type: SketchEvent, e: PointerEvent) {
    const pl = this.sketchPlane!;
    this.raycaster.setFromCamera(this.ndc(e.clientX, e.clientY), this.camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(v3(pl.normal), v3(pl.origin));
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return;
    const raw = toLocal(pl, [hit.x, hit.y, hit.z]);
    let p = raw;
    const ppu = this.pxPerUnit();
    let best: V2 | null = null;
    let bestKind: string | null = null;
    let bestD = SNAP_RADIUS / ppu;
    this.snapTargets.forEach((q, i) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bestD) [best, bestD, bestKind] = [q, d, this.snapKinds[i] ?? "точка"];
    });
    // Точки важнее линий; на линию прилипаем, только если рядом нет точки
    if (!best) {
      let lineD = (SNAP_RADIUS * 0.7) / ppu;
      for (const [a, b] of this.snapLines) {
        const q = closestOnSegment(raw, a, b);
        const d = Math.hypot(q[0] - raw[0], q[1] - raw[1]);
        if (d < lineD) [best, lineD, bestKind] = [q, d, "на линии"];
      }
    }
    if (best) p = [...(best as V2)];
    else {
      // Без привязки к сетке — точность 0.01 мм, чтобы не тащить «шум» float
      const s = this.gridSnap ? this.snapStep() : 0.01;
      p = [Math.round(p[0] / s) * s, Math.round(p[1] / s) * s].map((v) => +v.toFixed(4)) as V2;
    }
    this.onSketch(type, p, !!best, raw, bestKind);
  }

  /** Черновик эскиза: контуры, ломаные, маркер привязки, ручки точек, опорные линии и размеры */
  setDraft(v: DraftView) {
    const pl = this.sketchPlane;
    this.draftRoot.clear();
    if (!pl) return this.setDimLabels([]);
    const m = planeMatrix(pl, 0.1);
    const add = (o: THREE.Object3D) => {
      o.matrixAutoUpdate = false;
      o.matrix.copy(m);
      this.draftRoot.add(o);
    };
    const toV = (pts: V2[]) => pts.map(([x, y]) => new THREE.Vector3(x, y, 0));
    // Всё в черновике рисуется без проверки глубины — эскиз виден и внутри тела
    for (const p of v.closed) {
      const pts = outline(p);
      if (!isClosed(p)) {
        add(this.openLine(pts, this.palette.draft, p.kind === "axis", true));
        continue;
      }
      const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(toV(pts)), new THREE.LineBasicMaterial({ color: this.palette.draft, depthTest: false }));
      loop.renderOrder = 2;
      add(loop);
      const fill = new THREE.Mesh(
        new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)))),
        new THREE.MeshBasicMaterial({ color: 0x4c8dff, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, depthTest: false }),
      );
      fill.renderOrder = 1;
      add(fill);
    }
    for (const pts of v.open) {
      if (pts.length < 2) continue;
      const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(toV(pts)), new THREE.LineBasicMaterial({ color: 0xffb02e, depthTest: false }));
      ln.renderOrder = 2;
      add(ln);
    }
    if (v.hover && (v.hover.lines.length || v.hover.pts.length)) {
      const pos = v.hover.lines.flatMap((l) => l.slice(0, -1).flatMap((a, i) => [a[0], a[1], 0, l[i + 1][0], l[i + 1][1], 0]));
      if (pos.length) {
        const hl = new LineSegments2(new LineSegmentsGeometry().setPositions(pos), new LineMaterial({ color: 0x4fd1e8, linewidth: 4, depthTest: false }));
        hl.renderOrder = 5;
        add(hl);
      }
    }

    // Опорные линии (рёбра тела в плоскости эскиза, оси) — для размеров «точка — грань»
    if (v.refLines?.length) {
      const pos = v.refLines.flatMap(([a, b]) => [a[0], a[1], 0, b[0], b[1], 0]);
      const ref = new LineSegments2(new LineSegmentsGeometry().setPositions(pos), new LineMaterial({ color: 0x5dd39e, linewidth: 3, depthTest: false, transparent: true, opacity: 0.8 }));
      ref.renderOrder = 3;
      add(ref);
    }

    // Ручки точек: квадратики постоянного экранного размера
    const dots = (pts: V2[], color: number, size: number) => {
      if (!pts.length) return;
      const pts3 = new THREE.Points(
        new THREE.BufferGeometry().setFromPoints(toV(pts)),
        new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false }),
      );
      pts3.renderOrder = 4;
      add(pts3);
    };
    dots(v.handles ?? [], this.palette.draft, 9);
    dots(v.hover?.pts ?? [], 0x4fd1e8, 14);
    dots(v.selected ?? [], 0xffb02e, 13);

    const ppu = this.pxPerUnit();
    if (v.marker) {
      const r = 6 / ppu;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r * 0.55, r, 20),
        new THREE.MeshBasicMaterial({ color: v.markerHot ? 0x5dd39e : 0xffb02e, side: THREE.DoubleSide, depthTest: false }),
      );
      ring.position.set(v.marker[0], v.marker[1], 0);
      ring.updateMatrix();
      const holder = new THREE.Group();
      holder.add(ring);
      add(holder);
    }

    // Размерные линии: выносные линии, размерная линия с засечками, подпись по центру
    const seg: number[] = [];
    const line = (a: V2, b: V2) => seg.push(a[0], a[1], 0, b[0], b[1], 0);
    const labels: { at: V2; dim: Dim }[] = [];
    const over = 5 / ppu;
    const tick = 5 / ppu;
    for (const d of v.dims ?? []) {
      if (d.kind === "linear") {
        const len = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
        if (len < 1e-9) continue;
        const off = (d.offset ?? 24) / ppu;
        const dir: V2 = [(d.b[0] - d.a[0]) / len, (d.b[1] - d.a[1]) / len];
        const n: V2 = [-dir[1] * d.side, dir[0] * d.side];
        const at = (p: V2, k: number): V2 => [p[0] + n[0] * k, p[1] + n[1] * k];
        const A = at(d.a, off);
        const B = at(d.b, off);
        if (off > 0) {
          line(at(d.a, over), at(d.a, off + over));
          line(at(d.b, over), at(d.b, off + over));
        }
        line(A, B);
        const s: V2 = [(dir[0] + n[0]) * tick * 0.7, (dir[1] + n[1]) * tick * 0.7];
        for (const P of [A, B]) line([P[0] - s[0], P[1] - s[1]], [P[0] + s[0], P[1] + s[1]]);
        labels.push({ at: [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], dim: d });
      } else if (d.kind === "label") {
        labels.push({ at: d.at, dim: d });
      } else {
        const off = 24 / ppu;
        const u: V2 = [Math.SQRT1_2, Math.SQRT1_2];
        line([d.c[0] - u[0] * d.r, d.c[1] - u[1] * d.r], [d.c[0] + u[0] * (d.r + off), d.c[1] + u[1] * (d.r + off)]);
        labels.push({ at: [d.c[0] + u[0] * (d.r + off), d.c[1] + u[1] * (d.r + off)], dim: d });
      }
    }
    if (seg.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
      const ls = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: this.palette.dim, depthTest: false }));
      ls.renderOrder = 3;
      add(ls);
    }
    this.setDimLabels(labels.map(({ at, dim }) => ({ at: v3(toWorld(pl, at)), dim })));
  }

  /**
   * HTML-подписи размеров поверх холста; касание редактируемой подписи — ввод значения.
   * Элементы переиспользуются по id: пересоздание на каждое движение мыши давало «прыжки»
   * подписей из левого верхнего угла и сбрасывало нажатие.
   */
  private setDimLabels(items: { at: THREE.Vector3; dim: Dim }[]) {
    const keep = new Set(items.map((i) => i.dim.id));
    for (const [id, el] of this.dimEls) {
      if (!keep.has(id)) {
        el.remove();
        this.dimEls.delete(id);
      }
    }
    // Поля ввода размера живут, пока их не закроет обработчик редактирования
    this.dimLabels = items.map(({ at, dim }) => {
      let el = this.dimEls.get(dim.id);
      if (!el || el.dataset.editable !== String(dim.editable)) {
        el?.remove();
        el = document.createElement(dim.editable ? "button" : "span");
        el.className = "dim-label" + (dim.editable ? " editable" : "");
        el.dataset.editable = String(dim.editable);
        if (dim.editable) {
          const node = el;
          el.addEventListener("pointerdown", (e) => e.stopPropagation());
          el.addEventListener("click", () => this.onDimEdit(dim.id, node));
        }
        this.dimLayer.append(el);
        this.dimEls.set(dim.id, el);
      }
      if (el.textContent !== dim.text) el.textContent = dim.text;
      return { el, at };
    });
    this.updateDimLabels();
  }

  private updateDimLabels() {
    if (!this.dimLabels.length) return;
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    for (const { el, at } of this.dimLabels) {
      const p = at.clone().project(this.camera);
      const t = `translate(${(((p.x + 1) / 2) * w).toFixed(1)}px, ${(((1 - p.y) / 2) * h).toFixed(1)}px) translate(-50%, -50%)`;
      if (el.style.transform !== t) el.style.transform = t;
    }
  }

  /**
   * Опорные линии для размеров в плоскости эскиза: прямые рёбра тел, лежащие в этой
   * плоскости (контур грани, на которой эскиз), и оси эскиза через его начало.
   */
  refLines(): [V2, V2][] {
    const pl = this.sketchPlane;
    if (!pl) return [];
    const L = 1000;
    const lines: [V2, V2][] = [
      [[-L, 0], [L, 0]],
      [[0, -L], [0, L]],
    ];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const n = v3(pl.normal);
    const o = v3(pl.origin);
    for (const g of this.groups.values()) {
      const pos = (g.children[1] as THREE.LineSegments).geometry.getAttribute("position");
      for (const eg of g.userData.edgeGroups as { start: number; count: number }[]) {
        if (eg.count !== 2) continue; // только прямые рёбра
        a.fromBufferAttribute(pos, eg.start).add(g.position);
        b.fromBufferAttribute(pos, eg.start + 1).add(g.position);
        if (Math.abs(a.clone().sub(o).dot(n)) > 0.05 || Math.abs(b.clone().sub(o).dot(n)) > 0.05) continue;
        lines.push([toLocal(pl, [a.x, a.y, a.z]), toLocal(pl, [b.x, b.y, b.z])]);
      }
    }
    return lines;
  }

  /**
   * Рёбра тел, лежащие в плоскости эскиза: отрезки для привязки «на ребре», вершины,
   * середины прямых рёбер и центры круговых — для привязки к точкам.
   */
  planeSnaps(): { points: V2[]; kinds: string[]; lines: [V2, V2][] } {
    const pl = this.sketchPlane;
    const out = { points: [] as V2[], kinds: [] as string[], lines: [] as [V2, V2][] };
    if (!pl) return out;
    const n = v3(pl.normal);
    const o = v3(pl.origin);
    const v = new THREE.Vector3();
    for (const g of this.groups.values()) {
      const pos = (g.children[1] as THREE.LineSegments).geometry.getAttribute("position");
      for (const eg of g.userData.edgeGroups as { start: number; count: number }[]) {
        const pts: V2[] = [];
        let inPlane = true;
        for (let i = eg.start; i < eg.start + eg.count; i++) {
          v.fromBufferAttribute(pos, i).add(g.position);
          if (Math.abs(v.clone().sub(o).dot(n)) > 0.05) {
            inPlane = false;
            break;
          }
          pts.push(toLocal(pl, [v.x, v.y, v.z]));
        }
        if (!inPlane || pts.length < 2) continue;
        for (let i = 0; i + 1 < pts.length; i += 2) out.lines.push([pts[i], pts[i + 1]]);
        const [a, b] = [pts[0], pts[pts.length - 1]];
        const closedLoop = Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
        if (closedLoop) {
          // Замкнутое круговое ребро — центр как среднее точек окружности
          const c: V2 = [pts.reduce((s, q) => s + q[0], 0) / pts.length, pts.reduce((s, q) => s + q[1], 0) / pts.length];
          out.points.push(c);
          out.kinds.push("центр ребра");
        } else {
          out.points.push(a, b);
          out.kinds.push("вершина тела", "вершина тела");
          if (eg.count === 2) {
            out.points.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
            out.kinds.push("середина ребра");
          }
        }
      }
    }
    return out;
  }

  // ---------- масштаб ----------

  setGizmoMode(mode: "translate" | "scale") {
    this.gizmoMode = mode;
    if (!this.handleState && this.gizmo.object) this.gizmo.setMode(mode);
  }

  /** Во время перетаскивания приводим масштаб к допустимому для тела виду */
  private constrainScale(obj: THREE.Object3D) {
    const rule = this.scaleRule(obj.userData.bodyId);
    const s = obj.scale;
    const dominant = (...v: number[]) => v.reduce((m, x) => (Math.abs(Math.log(x)) > Math.abs(Math.log(m)) ? x : m), 1);
    if (rule === "uniform") s.setScalar(dominant(s.x, s.y, s.z));
    else if (rule === "xy") {
      const k = dominant(s.x, s.y);
      s.x = s.y = k;
    }
  }

  // ---------- вытягивание ----------

  /** Ручка-стрелка вдоль нормали профиля; перетаскивание меняет расстояние */
  showExtrudeHandle(origin: Vec3, normal: Vec3, distance: number, onChange: (d: number) => void) {
    this.handleState = { origin, normal, onChange };
    this.handle.position.copy(v3(origin)).addScaledVector(v3(normal), distance);
    this.handle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), v3(normal));
    this.gizmo.space = "local";
    this.gizmo.showX = this.gizmo.showY = false;
    this.gizmo.setMode("translate");
    this.gizmo.attach(this.handle);
  }

  setHandleDistance(d: number) {
    const h = this.handleState;
    if (h) this.handle.position.copy(v3(h.origin)).addScaledVector(v3(h.normal), d);
  }

  hideExtrudeHandle() {
    if (!this.handleState) return;
    this.handleState = null;
    this.gizmo.detach();
  }

  /** Миниатюра для списка проектов (без манипуляторов и предпросмотра) */
  thumbnail(width = 320): string {
    const helper = this.gizmo.getHelper();
    const hidden = [helper, this.previewRoot, this.draftRoot].filter((o) => o.visible);
    hidden.forEach((o) => (o.visible = false));
    // Читаем холст сразу после отрисовки — так не нужен preserveDrawingBuffer
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const c = document.createElement("canvas");
    c.width = width;
    c.height = Math.round((width * 3) / 4);
    // Обрезаем по центру до 4:3
    const k = Math.min(src.width / c.width, src.height / c.height);
    const sw = c.width * k;
    const sh = c.height * k;
    c.getContext("2d")!.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, c.width, c.height);
    hidden.forEach((o) => (o.visible = true));
    return c.toDataURL("image/jpeg", 0.8);
  }

  /**
   * Предпросмотр операции. opaque + hideBodyId — показать результат вместо тела
   * (скругление: полупрозрачный результат поверх оригинала был бы неразличим).
   */
  setPreview(shape: Shape | null, color = 0x4c8dff, opts: { opaque?: boolean; hideBodyId?: number } = {}) {
    this.previewRoot.clear();
    this.hiddenBodyId = shape ? (opts.hideBodyId ?? null) : null;
    for (const [id, g] of this.groups) g.visible = id !== this.hiddenBodyId;
    if (!shape) return;
    const m = mesh(shape);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(m.vertices, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(m.triangles, 1));
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(m.edges, 3));
    this.previewRoot.add(
      new THREE.Mesh(
        geo,
        opts.opaque
          ? new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })
          : new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false }),
      ),
      new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: opts.opaque ? this.palette.edges : color })),
    );
  }
}
