import "./style.css";
import { Doc, type Body, type RefPlane, type Sketch } from "./doc";
import {
  CONSTRAINTS,
  ORIGIN,
  lines as conLines,
  entName,
  entityAnchor,
  isValidRef,
  lineOf,
  pickEntity,
  prepareProfiles,
  sameEnt,
  solve,
  type Constraint,
  type ConstraintKind,
  type EntRef,
} from "./constraints";
import { sketchRegions } from "./regions";
import { recognize } from "./recognize";
import { Viewport, type Dim, type Pick, type PickMode, type ProfileRef, type SubSelection } from "./viewport";
import * as K from "./kernel";
import type { Primitive } from "./kernel";
import * as S from "./storage";
import { evalExpr, haptic, installNumpad, isTouchLike, uiConfirm, uiPrompt } from "./ui";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { deserialize, serialize } from "./project";
import {
  STD_PLANES,
  PROFILE_NAMES,
  anglePlane,
  offsetPlane,
  plane3,
  centroid,
  closestOnSegment,
  corners,
  deleteHandle,
  dist2,
  fmt,
  footOnLine,
  handles,
  isCorner,
  moveHandle,
  outline,
  rectFrom,
  rectFromCenter,
  setCornerRadius,
  isClosed,
  segments,
  snapPointsTyped,
  toWorld,
  translateProfile,
  type Profile,
  type RefDim,
  type SketchPlane,
  type V2,
  type Vec3,
} from "./sketch";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const doc = new Doc();
const view = new Viewport($("#viewport"));

type Mode = "normal" | "pickPlane" | "sketch" | "plane" | "pickAxis";
let mode: Mode = "normal";
let selection: number[] = [];
let selProfile: ProfileRef | null = null;
let multi = false;
let pickMode: PickMode = (["auto", "body", "face", "edge"].includes(getPref("pick") ?? "") ? getPref("pick") : "auto") as PickMode;
/** Выбранные грани/рёбра одного тела; body — версия тела, к которой относятся id */
let sub: (SubSelection & { body: Body }) | null = null;
/** Выбранная вспомогательная плоскость */
let selPlane: number | null = null;

// ---------- уведомления ----------
let toastTimer = 0;
function toast(msg: string, error = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (error ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.className = ""), error ? 4000 : 1800);
}

/** Предупреждение о пределах ядра — дольше на экране и отдельного цвета */
function warn(msg: string) {
  const t = $("#toast");
  t.textContent = `⚠ ${msg}`;
  t.className = "show warn";
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.className = ""), 6000);
}

function status(msg: string) {
  $("#status").textContent = msg;
}

/** Выполнить операцию ядра с перехватом ошибок OpenCascade */
const SLOW_OP_MS = 2000;

function run(label: string, fn: () => void, failHint?: string) {
  const t0 = performance.now();
  // Название операции — подпись шага на шкале истории
  doc.action = label;
  try {
    fn();
  } catch (err) {
    console.error(err);
    toast(`${label}: операция не удалась${failHint ? ". " + failHint : ""}`, true);
    return;
  } finally {
    doc.action = undefined;
  }
  // Медленная операция — признак того, что геометрия сложна для ядра в браузере
  const dt = performance.now() - t0;
  if (dt > SLOW_OP_MS) warn(`${label} заняла ${(dt / 1000).toFixed(1)} с — геометрия сложная для ядра, дальше операции будут медленнее`);
}

// Отладка в режиме разработки: window.__view.renderer.info — расход видеопамяти
if (import.meta.env.DEV) (window as unknown as { __view: Viewport }).__view = view;

view.onContextLost = () => toast("Видеопамять переполнена — восстанавливаю картинку…", true);
view.onContextRestored = () => {
  refresh();
  if (draft) drawDraft();
  toast("Картинка восстановлена");
};

view.onHeavyMesh = (name, tris) =>
  warn(`«${name}»: ${Math.round(tris / 1000)} тыс. треугольников — тело тяжёлое для планшета; упростите скругления или разбейте на части`);

// ---------- выбор ----------
function select(id: number | null) {
  selProfile = null;
  sub = null;
  selPlane = null;
  if (id === null) selection = multi ? selection : [];
  else if (multi) selection = selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id];
  else selection = selection.length === 1 && selection[0] === id ? [] : [id];
  refresh();
}

function selectProfile(ref: ProfileRef) {
  selection = [];
  sub = null;
  selPlane = null;
  selProfile = ref;
  ex.mode = "auto";
  refresh();
}

/** Касание грани/ребра переключает его в выборе; другое тело — новый выбор */
function toggleSub(bodyId: number, kind: "faces" | "edges", id: number) {
  const body = doc.get(bodyId)!;
  if (!sub || sub.bodyId !== bodyId || sub.body !== body) sub = { bodyId, body, faces: [], edges: [] };
  sub[kind] = sub[kind].includes(id) ? sub[kind].filter((x) => x !== id) : [...sub[kind], id];
  if (!sub.faces.length && !sub.edges.length) sub = null;
  selection = [];
  selProfile = null;
  refresh();
}

const DOUBLE_TAP_MS = 380;
let lastTap: { t: number; bodyId: number } | null = null;

function selectWholeBody(id: number) {
  if (doc.get(id)?.locked) return toast("Тело заблокировано");
  sub = null;
  selProfile = null;
  selPlane = null;
  selection = multi ? [...new Set([...selection, id])] : [id];
  haptic("tick");
  refresh();
}

function setPickMode(m: PickMode) {
  pickMode = m;
  setPref("pick", m);
  sub = null;
  if (m !== "body") selection = [];
  refresh();
}

function selectPlane(id: number) {
  selection = [];
  sub = null;
  selProfile = null;
  selPlane = selPlane === id ? null : id;
  refresh();
}

view.onTap = (pick: Pick) => {
  if (mode === "pickPlane") return pickPlane(pick);
  if (mode === "pickAxis") return pickArrayAxis(pick);
  if (mode === "plane") return planeToolTap(pick);
  if (!pick) return select(null);
  if (pick.kind === "profile") {
    if (pick.region === undefined) return selectProfile({ sketchId: pick.sketchId, index: pick.index });
    // Авто-области одного эскиза набираются касаниями (повторное касание — убрать)
    const cur = selProfile?.sketchId === pick.sketchId ? (selProfile.regions ?? []) : [];
    const regions = cur.includes(pick.region) ? cur.filter((r) => r !== pick.region) : [...cur, pick.region];
    haptic("tick");
    if (!regions.length) {
      selProfile = null;
      return refresh();
    }
    return selectProfile({ sketchId: pick.sketchId, index: -1, regions });
  }
  if (pick.kind === "plane") return selectPlane(pick.id);
  if (pick.kind === "vertex") return;
  // Двойное касание одного тела — выбрать тело целиком (вместо грани/ребра)
  const now = performance.now();
  const twice = lastTap && lastTap.bodyId === pick.id && now - lastTap.t < DOUBLE_TAP_MS;
  lastTap = { t: now, bodyId: pick.id };
  if (twice && (pick.kind === "face" || pick.kind === "edge")) {
    lastTap = null;
    return selectWholeBody(pick.id);
  }
  if (pick.kind === "face") return toggleSub(pick.id, "faces", pick.faceId);
  if (pick.kind === "edge") return toggleSub(pick.id, "edges", pick.edgeId);
  select(pick.id);
};

view.onGesture = (g) => {
  if (!$("#projects").classList.contains("hidden") || document.querySelector(".modal")) return;
  if (mode === "sketch") {
    if (g === "undo") {
      stepBack();
      toast("↶ Шаг назад");
    }
    return;
  }
  if (mode !== "normal") return;
  if (g === "undo" ? !doc.canUndo() : !doc.canRedo()) return toast(g === "undo" ? "Нечего отменять" : "Нечего повторять");
  if (g === "undo") doc.undo();
  else doc.redo();
  haptic("confirm");
  toast(g === "undo" ? "↶ Отменено" : "↷ Повторено");
};

view.onBoxSelect = (ids, additive) => {
  selProfile = null;
  sub = null;
  selPlane = null;
  if (pickMode !== "body") pickMode = "body";
  selection = additive || multi ? [...new Set([...selection, ...ids])] : ids;
  if (ids.length) toast(`Выбрано тел: ${selection.length}`);
  refresh();
};

function selectAll() {
  selProfile = null;
  sub = null;
  selPlane = null;
  selection = doc.bodies.filter((b) => !b.hidden && !b.locked).map((b) => b.id);
  refresh();
}

// ---------- тела ----------
const DEFAULTS: Record<Primitive["kind"], Primitive> = {
  box: { kind: "box", w: 40, d: 40, h: 40 },
  cylinder: { kind: "cylinder", r: 20, h: 40 },
  sphere: { kind: "sphere", r: 20 },
};
const KIND_NAMES = { box: "Куб", cylinder: "Цилиндр", sphere: "Сфера" };

function addPrimitive(kind: Primitive["kind"]) {
  const prim = { ...DEFAULTS[kind] };
  // Новые тела ставим чуть в стороне, чтобы не прятались друг в друге
  const n = doc.bodies.length;
  const offset: Vec3 = [n * 15, n * 15, 0];
  run("Создание", () => {
    const body = doc.newBody({ shape: K.buildPrimitive(prim, offset), prim, offset });
    body.name = `${KIND_NAMES[kind]} ${body.id}`;
    selection = [body.id];
    selProfile = null;
    doc.replace([body]);
  });
}

function selectedBodies(): Body[] {
  return selection.map((id) => doc.get(id)).filter(Boolean) as Body[];
}

function boolean(op: "union" | "subtract" | "intersect") {
  const [target, ...tools] = selectedBodies();
  if (!target || tools.length === 0) return toast("Выберите минимум 2 тела (включите «Мультивыбор»)");
  if ([target, ...tools].some((b) => b.locked)) return toast("Среди выбранных есть заблокированные тела", true);
  const fn = { union: K.union, subtract: K.subtract, intersect: K.intersect }[op];
  run("Булева операция", () => {
    const shape = tools.reduce((acc, t) => fn(acc, t.shape), target.shape);
    const result: Body = { ...target, shape, prim: undefined };
    selection = [target.id];
    doc.replace([result], tools.map((t) => t.id));
  });
}

function moveBody(id: number, d: Vec3) {
  const b = doc.get(id);
  if (!b) return;
  run("Перемещение", () => {
    const offset: Vec3 = [b.offset[0] + d[0], b.offset[1] + d[1], b.offset[2] + d[2]];
    // У примитива пересобираем из параметров — так числа остаются «чистыми»
    const shape = b.prim ? K.buildPrimitive(b.prim, offset) : K.translate(b.shape, d);
    doc.replace([{ ...b, shape, offset }]);
  });
}

function updatePrimitive(b: Body, prim: Primitive) {
  run("Изменение размеров", () => doc.replace([{ ...b, prim, shape: K.buildPrimitive(prim, b.offset) }]));
}

// ---------- масштаб ----------
let gizmoMode: "translate" | "scale" = "translate";

/**
 * Своя сборка ядра умеет растягивать любые тела (BRepBuilderAPI_GTransform),
 * поэтому все оси свободны. Ограничение оставлено как точка расширения.
 */
function scaleRuleOf(_b: Body): "free" | "xy" | "uniform" {
  return "free";
}

const uniform = (sx: number, sy: number, sz: number) => Math.abs(sx - sy) < 1e-9 && Math.abs(sy - sz) < 1e-9;

view.scaleRule = (id) => {
  const b = doc.get(id);
  return b ? scaleRuleOf(b) : "uniform";
};

/** Масштаб относительно центра тела; примитивы сохраняют редактируемые размеры */
function scaleBody(id: number, [sx, sy, sz]: Vec3) {
  const b = doc.get(id);
  const c = view.centerOf(id);
  if (!b || !c) return;
  run("Масштаб", () => {
    const p = b.prim;
    let prim: Primitive | undefined;
    let offset: Vec3 = b.offset;
    // У примитивов основание в offset, центр по Z — выше на половину высоты (у сферы — на радиус)
    // Округляем, чтобы в полях размеров не появлялись «хвосты» вроде 114.00000000000001
    const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
    if (p?.kind === "box") {
      prim = { ...p, w: r6(p.w * sx), d: r6(p.d * sy), h: r6(p.h * sz) };
      offset = [c[0], c[1], c[2] - prim.h / 2];
    } else if (p?.kind === "cylinder" && Math.abs(sx - sy) < 1e-9) {
      prim = { ...p, r: r6(p.r * sx), h: r6(p.h * sz) };
      offset = [c[0], c[1], c[2] - prim.h / 2];
    } else if (p?.kind === "sphere" && uniform(sx, sy, sz)) {
      prim = { ...p, r: r6(p.r * sx) };
      offset = [c[0], c[1], c[2] - prim.r];
    }
    // Остальное (эллиптический цилиндр, эллипсоид, любые тела) — растяжение в ядре
    const shape = prim ? K.buildPrimitive(prim, offset) : K.scaleAxes(b.shape, [sx, sy, sz], c);
    if (!prim && !uniform(sx, sy, sz) && b.shape.faces.some((f) => f.geomType !== "PLANE"))
      warn("Растяжение превратило кривые грани в сплайны — скругления и оболочка на этом теле будут медленнее");
    doc.replace([{ ...b, shape, prim, offset }]);
  });
}

view.onScaleEnd = scaleBody;

// ---------- массивы ----------
const arr = {
  kind: "linear" as "linear" | "circular",
  count: 3,
  /** X / Y / Z, "pick" — выбранное ребро/цилиндр, "sk:<эскиз>:<профиль>" — ось эскиза */
  axis: "X" as string,
  /** Ось, взятая с ребра или цилиндра */
  picked: null as { origin: Vec3; dir: Vec3; label: string } | null,
  /** Тело, для которого выбирается ось (чтобы вернуться к нему) */
  forBody: null as number | null,
  step: 50,
  angle: 360,
  center: [0, 0, 0] as Vec3,
  merge: false,
};
const AXES: Record<"X" | "Y" | "Z", Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

/** Копии тела: по прямой с шагом или по окружности вокруг оси через центр */
/** Ось массива: стандартная, выбранная на теле или ось эскиза (в мировых координатах) */
function arrayAxis(): { origin: Vec3; dir: Vec3 } | null {
  if (arr.axis === "X" || arr.axis === "Y" || arr.axis === "Z") return { origin: arr.center, dir: AXES[arr.axis] };
  if (arr.axis === "pick") return arr.picked;
  const [, skId, pi] = arr.axis.split(":");
  const sk = doc.getSketch(Number(skId));
  const p = sk?.profiles[Number(pi)];
  if (!sk || p?.kind !== "axis") return null;
  const a = toWorld(sk.plane, p.a);
  const b = toWorld(sk.plane, p.b);
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(...d);
  return { origin: a, dir: [d[0] / l, d[1] / l, d[2] / l] };
}

function beginPickAxis(b: Body) {
  mode = "pickAxis";
  arr.forBody = b.id;
  refresh();
  status("Коснитесь ребра (прямого — вдоль него, круглого — вокруг его центра) или цилиндра");
}

function pickArrayAxis(pick: Pick) {
  const finish = () => {
    mode = "normal";
    selection = arr.forBody !== null && doc.get(arr.forBody) ? [arr.forBody] : [];
    status("");
    refresh();
  };
  if (!pick) return finish();
  try {
    if (pick.kind === "edge") {
      const ax = cached(doc.get(pick.id)!.shape, `ax${pick.edgeId}`, () => K.edgeAxis(doc.get(pick.id)!.shape, pick.edgeId));
      arr.picked = { origin: ax.origin, dir: ax.dir, label: ax.kind === "circle" ? "ось круглого ребра" : "прямое ребро" };
    } else if (pick.kind === "face") {
      const ax = K.faceAxis(doc.get(pick.id)!.shape, pick.faceId);
      if (!ax) return toast("Коснитесь ребра или цилиндрической грани");
      arr.picked = { ...ax, label: "ось цилиндра" };
    } else return toast("Коснитесь ребра или цилиндрической грани");
  } catch (err) {
    return warn(`${(err as Error).message} — ядро определяет оси только у прямых и круговых рёбер`);
  }
  arr.axis = "pick";
  finish();
}

function applyArray(b: Body) {
  const n = Math.round(arr.count);
  if (!(n >= 2)) return toast("Количество — минимум 2", true);
  const ax = arrayAxis();
  if (!ax) return toast("Выберите ось массива", true);
  const axis = ax.dir;
  const full = Math.abs(arr.angle) >= 360 - 1e-6;
  const stepA = full ? arr.angle / n : arr.angle / (n - 1);
  run("Массив", () => {
    const copies: { shape: K.Shape; prim?: Primitive; offset: Vec3 }[] = [];
    for (let k = 1; k < n; k++) {
      if (arr.kind === "linear") {
        const d: Vec3 = [axis[0] * arr.step * k, axis[1] * arr.step * k, axis[2] * arr.step * k];
        const offset: Vec3 = [b.offset[0] + d[0], b.offset[1] + d[1], b.offset[2] + d[2]];
        copies.push(b.prim ? { shape: K.buildPrimitive(b.prim, offset), prim: b.prim, offset } : { shape: K.translate(b.shape, d), offset: [0, 0, 0] });
      } else {
        copies.push({ shape: K.rotate(b.shape, stepA * k, ax.origin, axis), offset: [0, 0, 0] });
      }
    }
    if (arr.merge) {
      const shape = copies.reduce((acc, c) => K.union(acc, c.shape), b.shape);
      doc.replace([{ ...b, shape, prim: undefined }]);
      return;
    }
    const bodies = copies.map((c, k) => {
      const nb = doc.newBody({ ...c, color: b.color });
      nb.name = `${b.name} · ${k + 2}`;
      return nb;
    });
    selection = [b.id];
    doc.replace(bodies);
    toast(`Создано копий: ${bodies.length}`);
  });
}

function renderArraySection(root: HTMLElement, b: Body) {
  root.append(
    el("h3", { textContent: "Массив" }),
    segmented(
      [["linear", "По прямой"], ["circular", "По кругу"]],
      arr.kind,
      (v) => {
        arr.kind = v as typeof arr.kind;
        renderProps();
      },
    ),
    numberField("Количество", arr.count, (v) => (arr.count = v)),
  );
  const axisOpts: [string, string][] = [["X", "Ось X"], ["Y", "Ось Y"], ["Z", "Ось Z"]];
  if (arr.picked) axisOpts.push(["pick", `Выбранная: ${arr.picked.label}`]);
  for (const sk of doc.sketches) sketchAxes(sk).forEach((x, k) => axisOpts.push([`sk:${sk.id}:${x.i}`, `Ось ${k + 1} — ${sk.name}`]));
  root.append(
    selectField(arr.kind === "linear" ? "Направление" : "Ось вращения", axisOpts, arr.axis, (v) => {
      arr.axis = v;
      renderProps();
    }),
    buttonRow([arr.kind === "linear" ? "Вдоль ребра…" : "Ось по ребру / цилиндру…", () => beginPickAxis(b)]),
  );
  if (arr.kind === "linear") root.append(numberField("Шаг, мм", arr.step, (v) => (arr.step = v)));
  else {
    root.append(numberField("Угол всего, °", arr.angle, (v) => (arr.angle = v)));
    if (["X", "Y", "Z"].includes(arr.axis)) (["X", "Y", "Z"] as const).forEach((a, i) => root.append(numberField(`Центр оси ${a}`, arr.center[i], (v) => (arr.center[i] = v))));
  }
  root.append(
    selectField("Результат", [["sep", "Отдельные тела"], ["merge", "Одно тело"]], arr.merge ? "merge" : "sep", (v) => (arr.merge = v === "merge")),
    buttonRow(["Создать массив", () => applyArray(b)]),
  );
}

function edgeOp(b: Body, kind: "fillet" | "chamfer", r: number) {
  if (!(r > 0)) return toast("Укажите радиус больше нуля");
  run(kind === "fillet" ? "Скругление" : "Фаска", () => {
    const shape = kind === "fillet" ? K.fillet(b.shape, r) : K.chamfer(b.shape, r);
    doc.replace([{ ...b, shape, prim: undefined }]);
  });
}

function duplicate() {
  copyBodies(selection);
}

/** Копии тел со сдвигом; копия не наследует блокировку и скрытие */
function copyBodies(ids: number[]) {
  const src = ids.map((id) => doc.get(id)).filter(Boolean) as Body[];
  const copies = src.map((b) => {
    const d: Vec3 = [20, 20, 0];
    const offset: Vec3 = [b.offset[0] + d[0], b.offset[1] + d[1], b.offset[2]];
    const shape = b.prim ? K.buildPrimitive(b.prim, offset) : K.translate(b.shape, d);
    const copy = doc.newBody({ shape, prim: b.prim, offset, color: b.color });
    copy.name = `${b.name} (копия)`;
    return copy;
  });
  if (!copies.length) return;
  selection = copies.map((c) => c.id);
  selProfile = null;
  sub = null;
  doc.replace(copies);
}

async function renameBody(id: number) {
  const b = doc.get(id);
  const v = b && (await uiPrompt("Название тела", b.name));
  const cur = doc.get(id);
  if (cur && v && v !== cur.name) doc.replace([{ ...cur, name: v }]);
}

async function renameSketch(id: number) {
  const sk = doc.getSketch(id);
  const v = sk && (await uiPrompt("Название эскиза", sk.name));
  const cur = doc.getSketch(id);
  if (cur && v && v !== cur.name) doc.change({ sketches: [{ ...cur, name: v }] });
}

function deleteBodies(ids: number[]) {
  const locked = ids.filter((id) => doc.get(id)?.locked);
  const del = ids.filter((id) => !locked.includes(id));
  if (locked.length) toast(`Заблокированные тела не удаляются: ${locked.length}`, true);
  if (!del.length) return;
  selection = selection.filter((id) => !del.includes(id));
  doc.replace([], del);
}

function setBodyFlag(ids: number[], flag: "hidden" | "locked", value: boolean) {
  const changed = ids.map((id) => doc.get(id)).filter((b): b is Body => !!b && !!b[flag] !== value).map((b) => ({ ...b, [flag]: value }));
  if (!changed.length) return;
  // Скрытое или заблокированное тело не должно оставаться выбранным для правки
  if (value) selection = selection.filter((id) => !ids.includes(id) || flag === "locked");
  doc.replace(changed);
  toast(`${flag === "hidden" ? (value ? "Скрыто" : "Показано") : value ? "Заблокировано" : "Разблокировано"}: ${changed.length}`);
}

function remove() {
  if (selProfile?.regions) return toast("Область — часть пересекающихся контуров; удалите линии в эскизе");
  if (selProfile) return deleteProfile(selProfile);
  if (selPlane !== null) return deletePlane(selPlane);
  if (sub) return toast("Удалять можно тела и профили; для граней используйте «Тяни-толкай» или «Оболочку»");
  if (!selection.length) return;
  deleteBodies(selection);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * В браузере — обычное скачивание. В APK скачивание через <a download> не работает:
 * пишем в «Документы/CAD.remeslo», а если нет доступа — открываем меню «Поделиться».
 */
async function download(blob: Blob, name: string, doneMsg = "") {
  if (!Capacitor.isNativePlatform()) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    if (doneMsg) toast(doneMsg);
    return;
  }
  const data = await blobToBase64(blob);
  const path = `CAD.remeslo/${name}`;
  try {
    await Filesystem.writeFile({ path, data, directory: Directory.Documents, recursive: true });
    toast(`${doneMsg ? doneMsg + ". " : ""}Сохранено: Документы/${path}`);
  } catch (err) {
    console.error(err);
    try {
      const { uri } = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache });
      await Share.share({ title: name, files: [uri] });
    } catch (err2) {
      console.error(err2);
      toast("Не удалось сохранить файл", true);
    }
  }
}

function exportFile(fmt: "stl" | "step") {
  const bodies = selectedBodies().length ? selectedBodies() : doc.bodies.filter((b) => !b.hidden);
  if (!bodies.length) return toast("Нечего экспортировать");
  run("Экспорт", () => {
    const blob =
      fmt === "stl" ? K.exportSTL(bodies.map((b) => b.shape)) : K.exportSTEPFile(bodies.map((b) => ({ shape: b.shape, name: b.name })));
    download(blob, `${fileSafe(projectName)}.${fmt}`, `Экспортировано тел: ${bodies.length}`);
  });
}

// ---------- эскиз ----------
type Tool = "select" | "line" | "free" | "rect" | "crect" | "circle" | "ellipse" | "slot" | "axis" | "dim" | "constraint";
/** Авто-связь отрезка ломаной, которая ещё рисуется (i = -1 — эта же ломаная) */
interface PendCon {
  kind: ConstraintKind;
  seg: number;
  ref?: EntRef;
}
type HandleRef = { i: number; h: number };
interface Draft {
  sketchId?: number;
  name: string;
  plane: SketchPlane;
  hostBodyId?: number;
  profiles: Profile[];
  /** Размеры от точек эскиза до рёбер тела/осей */
  refDims: RefDim[];
  /** Опорные линии для размеров — считаются один раз при входе в эскиз */
  refLines: [V2, V2][];
  tool: Tool;
  /** Первая точка фигуры */
  start: V2 | null;
  /** start поставлен этим же нажатием (если палец не сдвинулся — ждём второе касание) */
  pressStarted: boolean;
  /** Паз: задана осевая линия, ждём ширину */
  slotLine: [V2, V2] | null;
  /** Точки незамкнутой ломаной */
  poly: V2[];
  cursor: V2 | null;
  cursorHot: boolean;
  /** Что сработало при привязке курсора (для строки состояния) */
  snapKind: string | null;
  /** Элемент под курсором — подсвечивается */
  hoverEnt: { pts: V2[]; lines: V2[][] } | null;
  /** Ортогональный режим: отрезки строго горизонтально/вертикально */
  ortho: boolean;
  /** Привязки к телу в плоскости эскиза (считаются один раз) */
  bodySnaps: { points: V2[]; kinds: string[]; lines: [V2, V2][] };
  /** Выбранная точка (инструмент «Точки») */
  sel: HandleRef | null;
  drag: (HandleRef & { orig: Profile }) | null;
  /** Первая точка размера (инструмент «Размер») */
  dimFirst: HandleRef | null;
  /** Геометрические связи и их создание */
  constraints: Constraint[];
  conKind: ConstraintKind;
  conFirst: EntRef | null;
  /** Авто-связи при рисовании: горизонталь/вертикаль, параллельность, совпадение точек */
  autoCon: boolean;
  pend: PendCon[];
  autoHint: { p: V2; kind: ConstraintKind; ref?: EntRef } | null;
  /** Штрих инструмента «От руки» */
  stroke: V2[] | null;
  /** Снимки черновика для «шага назад»: геометрия, связи и размеры вместе */
  undo: string[];
}
let draft: Draft | null = null;

const TOOLS: { id: Tool; ico: string; label: string; hint: string }[] = [
  { id: "select", ico: "⬚", label: "Точки", hint: "Тяните точку, чтобы переместить её. Касание точки — выбор: её можно удалить или скруглить угол." },
  { id: "line", ico: "╱", label: "Линия", hint: "Касайтесь точек по очереди. Коснитесь первой точки, чтобы замкнуть контур. Незамкнутые линии сохраняются при смене инструмента. Почти горизонтальный, вертикальный или параллельный отрезок выравнивается сам (значок у отрезка)." },
  { id: "free", ico: "✍", label: "От руки", hint: "Нарисуйте фигуру одним движением — она распознается: линия, ломаная, окружность, эллипс, прямоугольник, треугольник или многоугольник. Концы прилипают к точкам эскиза." },
  { id: "rect", ico: "▭", label: "Прямоуг.", hint: "Проведите от угла до угла (или два касания)." },
  { id: "crect", ico: "⊡", label: "Из центра", hint: "Проведите от центра до угла (или два касания)." },
  { id: "circle", ico: "◯", label: "Круг", hint: "Проведите от центра до края (или два касания)." },
  { id: "ellipse", ico: "⬭", label: "Эллипс", hint: "Проведите от центра до угла описанного прямоугольника." },
  { id: "slot", ico: "⊂⊃", label: "Паз", hint: "Проведите осевую линию паза, затем отведите палец, задавая ширину, и коснитесь." },
  { id: "axis", ico: "┆", label: "Ось", hint: "Проведите ось (или два касания). Ось нужна для тел вращения и массивов по кругу." },
  { id: "constraint", ico: "∥", label: "Связи", hint: "Выберите тип связи и коснитесь элементов эскиза. Начало координат и оси X/Y тоже можно выбрать — они неподвижны." },
  { id: "dim", ico: "↔", label: "Размер", hint: "Коснитесь отрезка или окружности — нанесётся размер (длина или диаметр), он держит значение как связь. Точка, затем ребро тела или ось (зелёные линии) — размер до ребра. Касание числа — изменить, пустое поле — удалить." },
];

function beginSketch() {
  mode = "pickPlane";
  selection = [];
  selProfile = null;
  refresh();
}

function pickPlane(pick: Pick) {
  if (!pick) return;
  if (pick.kind === "plane") return startSketch(doc.getPlane(pick.id)!.plane);
  if (pick.kind === "profile") {
    const sk = doc.getSketch(pick.sketchId)!;
    return startSketch(sk.plane, sk.hostBodyId);
  }
  if (pick.kind === "edge" || pick.kind === "vertex") return;
  const body = doc.get(pick.id)!;
  const plane = K.facePlane(body.shape, pick.faceId);
  if (!plane) return toast("Эскиз можно рисовать только на плоской грани", true);
  startSketch(plane, body.id);
}

function startSketch(plane: SketchPlane, hostBodyId?: number, existing?: Sketch) {
  mode = "sketch";
  view.enterSketch(plane);
  draft = {
    sketchId: existing?.id,
    name: existing?.name ?? "",
    plane,
    hostBodyId,
    profiles: existing ? [...existing.profiles] : [],
    refDims: existing?.refDims ? [...existing.refDims] : [],
    constraints: existing?.constraints ? [...existing.constraints] : [],
    conKind: "parallel",
    conFirst: null,
    autoCon: getPref("autoCon") !== "0",
    undo: [],
    pend: [],
    autoHint: null,
    stroke: null,
    snapKind: null,
    hoverEnt: null,
    ortho: draft?.ortho ?? false,
    bodySnaps: { points: [], kinds: [], lines: [] },
    refLines: view.refLines(),
    tool: "rect",
    start: null,
    pressStarted: false,
    slotLine: null,
    poly: [],
    cursor: null,
    cursorHot: false,
    sel: null,
    drag: null,
    dimFirst: null,
  };
  // Вершины и рёбра тела в плоскости эскиза — для привязки (после sync: тела уже в сцене)
  refresh();
  draft.bodySnaps = view.planeSnaps();
  status("Эскиз: рисуйте пальцем или стилусом");
  drawDraft();
}

/** Запомнить состояние черновика перед правкой — «шаг назад» вернёт его целиком */
function keepStep(d: Draft) {
  d.undo.push(JSON.stringify({ profiles: d.profiles, constraints: d.constraints, refDims: d.refDims, poly: d.poly, pend: d.pend }));
  if (d.undo.length > 150) d.undo.shift();
}

function restoreSnap(d: Draft, json: string) {
  const st = JSON.parse(json);
  d.profiles = st.profiles;
  d.constraints = st.constraints;
  d.refDims = st.refDims;
  d.poly = st.poly;
  d.pend = st.pend;
  d.sel = d.dimFirst = d.conFirst = d.drag = null;
  if (d.poly.length && d.tool !== "line") d.tool = "line";
}

/** Незаконченная ломаная становится отдельным элементом «Линии» */
function keepOpenPoly(d: Draft) {
  if (d.poly.length >= 2) {
    keepStep(d);
    d.profiles.push({ kind: "path", pts: d.poly });
    flushPending(d, d.profiles.length - 1, false);
    autoAttach(d, d.profiles.length - 1);
  }
  d.poly = [];
  d.pend = [];
}

/** Авто-связи отрезков законченной ломаной получают номер её профиля */
function flushPending(d: Draft, i: number, closed: boolean) {
  const n = d.poly.length;
  const fix = (r: EntRef): EntRef => (r.i === -1 ? { ...r, i } : r);
  for (const pc of d.pend) {
    if (pc.seg >= (closed ? n : n - 1)) continue;
    const me: EntRef = { i, e: pc.seg, t: "line" };
    d.constraints.push(pc.ref ? { kind: pc.kind, a: fix(pc.ref), b: me, auto: true } : { kind: pc.kind, a: me, b: me, auto: true });
  }
  d.pend = [];
}

/**
 * Точки нового профиля, попавшие (привязкой) в точку или на отрезок другого профиля,
 * связываются с ним — при правке размеров фигуры остаются соединёнными
 */
function autoAttach(d: Draft, i: number) {
  if (!d.autoCon) return;
  const P = d.profiles[i];
  handles(P).forEach((q, h) => {
    if (P.kind === "rect" && h === 4) return; // центр прямоугольника
    if (Math.hypot(q[0], q[1]) < 1e-6) {
      d.constraints.push({ kind: "coincident", a: { i: ORIGIN, e: 0, t: "pt" }, b: { i, e: h, t: "pt" }, auto: true });
      return;
    }
    for (let j = 0; j < d.profiles.length; j++) {
      if (j === i) continue;
      const Q = d.profiles[j];
      const k = handles(Q).findIndex((x, kk) => !(Q.kind === "rect" && kk === 4) && dist2(x, q) < 1e-6);
      if (k >= 0) {
        d.constraints.push({ kind: "coincident", a: { i: j, e: k, t: "pt" }, b: { i, e: h, t: "pt" }, auto: true });
        return;
      }
    }
    for (let j = 0; j < d.profiles.length; j++) {
      const Q = d.profiles[j];
      // Стороны прямоугольника не трогаем: связь «на линии» превратила бы его в многоугольник
      if (j === i || (Q.kind !== "poly" && Q.kind !== "path" && Q.kind !== "axis")) continue;
      const e = conLines(Q).findIndex(([a, b]) => dist2(q, closestOnSegment(q, a, b)) < 1e-6 && dist2(q, a) > 1e-6 && dist2(q, b) > 1e-6);
      if (e >= 0) {
        d.constraints.push({ kind: "onLine", a: { i, e: h, t: "pt" }, b: { i: j, e, t: "line" }, auto: true });
        return;
      }
    }
  });
}

const AUTO_DEG = 3;
/** Почти горизонтальный/вертикальный/параллельный отрезок ломаной — выровнять (мягкая привязка) */
function autoAlign(d: Draft, p: V2, snapped: boolean): Draft["autoHint"] {
  if (!d.autoCon || d.ortho || snapped || d.tool !== "line" || !d.poly.length) return null;
  const last = d.poly[d.poly.length - 1];
  const v: V2 = [p[0] - last[0], p[1] - last[1]];
  if (Math.hypot(...v) * view.pxPerUnit() < 24) return null;
  const tol = (AUTO_DEG * Math.PI) / 180;
  const ang = Math.atan2(v[1], v[0]);
  const err = (dir: number) => {
    const x = (((ang - dir) % Math.PI) + Math.PI) % Math.PI;
    return Math.min(x, Math.PI - x);
  };
  const r4 = (q: V2): V2 => [+q[0].toFixed(4), +q[1].toFixed(4)];
  if (err(0) < tol) return { p: r4([p[0], last[1]]), kind: "horizontal" };
  if (err(Math.PI / 2) < tol) return { p: r4([last[0], p[1]]), kind: "vertical" };
  const cands: { ref: EntRef; a: V2; b: V2; adjacent: boolean }[] = [];
  d.profiles.forEach((q, i) => {
    if (q.kind === "poly" || q.kind === "path" || q.kind === "axis") conLines(q).forEach(([a, b], e) => cands.push({ ref: { i, e, t: "line" }, a, b, adjacent: false }));
  });
  for (let e = 0; e + 1 < d.poly.length; e++) cands.push({ ref: { i: -1, e, t: "line" }, a: d.poly[e], b: d.poly[e + 1], adjacent: e === d.poly.length - 2 });
  let best: { kind: ConstraintKind; ref: EntRef; dir: number } | null = null;
  let bestErr = tol;
  for (const c of cands) {
    const la = Math.atan2(c.b[1] - c.a[1], c.b[0] - c.a[0]);
    // Горизонтальные и вертикальные линии уже учтены выше
    if (Math.abs(Math.sin(la * 2)) < 1e-6) continue;
    for (const [kind, off] of [["parallel", 0], ["perpendicular", Math.PI / 2]] as const) {
      if (kind === "parallel" && c.adjacent) continue; // продолжение того же отрезка
      const e = err(la + off);
      if (e < bestErr) [best, bestErr] = [{ kind, ref: c.ref, dir: la + off }, e];
    }
  }
  if (!best) return null;
  const b = best as { kind: ConstraintKind; ref: EntRef; dir: number };
  const dx = Math.cos(b.dir);
  const dy = Math.sin(b.dir);
  const t = v[0] * dx + v[1] * dy;
  return { p: r4([last[0] + dx * t, last[1] + dy * t]), kind: b.kind, ref: b.ref };
}

/** Привязка точки фигуры, распознанной из штриха: к точкам эскиза, иначе к сетке */
function snapFree(d: Draft, q: V2): V2 {
  const lim = 16 / view.pxPerUnit();
  let best: V2 | null = null;
  let bd = lim;
  for (const t of [...d.profiles.flatMap(snapPointsTyped).map((x) => x.p), ...d.bodySnaps.points, [0, 0] as V2]) {
    const dd = dist2(t, q);
    if (dd < bd) [best, bd] = [t, dd];
  }
  if (best) return [...(best as V2)] as V2;
  const s = view.gridSnap ? view.snapStep() : 0.01;
  return [+(Math.round(q[0] / s) * s).toFixed(4), +(Math.round(q[1] / s) * s).toFixed(4)];
}

function setTool(t: Tool) {
  const d = draft!;
  if (t !== "line") keepOpenPoly(d);
  d.stroke = null;
  d.autoHint = null;
  d.tool = t;
  d.start = d.slotLine = d.sel = d.dimFirst = d.conFirst = null;
  renderProps();
  drawDraft();
}

function commitProfile(p: Profile, fromPoly = false) {
  const d = draft!;
  // Ломаная уже запомнена по точкам — её замыкание отменяется вместе с последней точкой
  if (!fromPoly) keepStep(d);
  d.profiles.push(p);
  const i = d.profiles.length - 1;
  if (fromPoly) flushPending(d, i, p.kind === "poly");
  autoAttach(d, i);
  haptic("confirm");
  renderProps();
}

/** Удалить профиль i; размеры до граней сдвигают номера профилей */
function removeProfileAt(i: number) {
  const d = draft!;
  d.profiles.splice(i, 1);
  d.refDims = d.refDims.filter((r) => r.i !== i).map((r) => (r.i > i ? { ...r, i: r.i - 1 } : r));
  const shift = (r: EntRef) => (r.i > i ? { ...r, i: r.i - 1 } : r);
  d.constraints = d.constraints.filter((c) => c.a.i !== i && c.b.i !== i).map((c) => ({ ...c, a: shift(c.a), b: shift(c.b) }));
  d.sel = d.dimFirst = d.conFirst = null;
}

function deleteSelectedPoint() {
  const d = draft;
  if (!d?.sel) return;
  const { i, h } = d.sel;
  keepStep(d);
  const res = deleteHandle(d.profiles[i], h);
  if (res) {
    d.profiles[i] = res;
    // Номера точек профиля изменились — его размеры до граней и связи теряют смысл
    d.refDims = d.refDims.filter((r) => r.i !== i);
    d.constraints = d.constraints.filter((c) => c.a.i !== i && c.b.i !== i);
    d.sel = null;
  } else removeProfileAt(i);
  renderProps();
  drawDraft();
}

const isValid = (p: Profile) =>
  p.kind === "rect" ? p.w > 0 && p.h > 0
  : p.kind === "circle" ? p.r > 0
  : p.kind === "ellipse" ? p.rx > 0 && p.ry > 0
  : p.kind === "slot" ? p.r > 0 && dist2(p.a, p.b) > 0
  : p.kind === "axis" ? dist2(p.a, p.b) > 0
  : true;

/** Профиль, который сейчас «тянется» пальцем (для предпросмотра и размеров) */
function pendingProfile(d: Draft): Profile | null {
  if (!d.cursor) return null;
  if (d.tool === "slot" && d.slotLine) {
    const [a, b] = d.slotLine;
    return { kind: "slot", a, b, r: dist2(d.cursor, footOnLine(d.cursor, a, b)) };
  }
  if (!d.start) return null;
  const s = d.start;
  const c = d.cursor;
  switch (d.tool) {
    case "rect":
      return rectFrom(s, c);
    case "crect":
      return rectFromCenter(s, c);
    case "circle":
      return { kind: "circle", cx: s[0], cy: s[1], r: dist2(s, c) };
    case "ellipse":
      return { kind: "ellipse", cx: s[0], cy: s[1], rx: Math.abs(c[0] - s[0]), ry: Math.abs(c[1] - s[1]) };
    case "axis":
      return { kind: "axis", a: s, b: c };
    default:
      return null;
  }
}

const signedArea = (pts: V2[]) =>
  pts.reduce((s, a, i) => {
    const b = pts[(i + 1) % pts.length];
    return s + a[0] * b[1] - b[0] * a[1];
  }, 0) / 2;

/** Ближайшая к пальцу точка-ручка в пределах px пикселей */
function nearestHandle(d: Draft, raw: V2, px = 18): HandleRef | null {
  const lim = px / view.pxPerUnit();
  let best: HandleRef | null = null;
  let bestD = lim;
  d.profiles.forEach((p, i) =>
    handles(p).forEach((q, h) => {
      const dd = dist2(q, raw);
      if (dd < bestD) [best, bestD] = [{ i, h }, dd];
    }),
  );
  return best;
}

function nearestRefLine(d: Draft, raw: V2, px = 20): [V2, V2] | null {
  const lim = px / view.pxPerUnit();
  let best: [V2, V2] | null = null;
  let bestD = lim;
  for (const l of d.refLines) {
    const dd = dist2(raw, closestOnSegment(raw, l[0], l[1]));
    if (dd < bestD) [best, bestD] = [l, dd];
  }
  return best;
}

/** Точка размера до грани и основание перпендикуляра на опорной линии */
function refDimGeom(d: Draft, r: RefDim) {
  const p = d.profiles[r.i];
  const P = p && handles(p)[r.h];
  if (!P) return null;
  const Q = footOnLine(P, r.ref[0], r.ref[1]);
  return { P, Q, dist: dist2(P, Q) };
}

/** Размеры черновика: у готовых профилей — редактируемые, у рисуемого — только показ */
function sketchDims(d: Draft): Dim[] {
  const dims: Dim[] = [];
  const ppu = view.pxPerUnit();
  const add = (p: Profile, key: string, editable: boolean) => {
    switch (p.kind) {
      case "rect":
        dims.push({ id: `${key}:w`, kind: "linear", a: [p.x, p.y], b: [p.x + p.w, p.y], side: -1, text: fmt(p.w), editable });
        dims.push({ id: `${key}:h`, kind: "linear", a: [p.x, p.y], b: [p.x, p.y + p.h], side: 1, text: fmt(p.h), editable });
        break;
      case "circle":
        dims.push({ id: `${key}:d`, kind: "diameter", c: [p.cx, p.cy], r: p.r, text: `Ø ${fmt(p.r * 2)}`, editable });
        break;
      case "ellipse":
        dims.push({ id: `${key}:w`, kind: "linear", a: [p.cx - p.rx, p.cy - p.ry], b: [p.cx + p.rx, p.cy - p.ry], side: -1, text: fmt(p.rx * 2), editable });
        dims.push({ id: `${key}:h`, kind: "linear", a: [p.cx - p.rx, p.cy - p.ry], b: [p.cx - p.rx, p.cy + p.ry], side: 1, text: fmt(p.ry * 2), editable });
        break;
      case "slot":
        // Длина между центрами — сбоку от паза, ширина — у второго конца
        dims.push({ id: `${key}:L`, kind: "linear", a: p.a, b: p.b, side: 1, offset: p.r * ppu + 22, text: fmt(dist2(p.a, p.b)), editable });
        dims.push({ id: `${key}:W`, kind: "diameter", c: p.b, r: p.r, text: `Ш ${fmt(p.r * 2)}`, editable });
        break;
      case "poly": {
        // Размер снаружи контура: для обхода против часовой стрелки «наружу» — справа
        const side = signedArea(p.pts) > 0 ? -1 : 1;
        p.pts.forEach((a, j) => {
          const b = p.pts[(j + 1) % p.pts.length];
          dims.push({ id: `${key}:s${j}`, kind: "linear", a, b, side, text: fmt(dist2(a, b)), editable });
        });
      }
    }
  };
  // Размеры готовых фигур не показываем — только нанесённые инструментом «Размер» (это связи)
  d.constraints.forEach((c, k) => {
    if ((c.kind !== "length" && c.kind !== "diameter") || !isValidRef(d.profiles, c.a)) return;
    const P = d.profiles[c.a.i];
    if (c.kind === "length") {
      const [a, b] = lineOf(d.profiles, c.a);
      const side = P.kind === "rect" || (P.kind === "poly" && signedArea(P.pts) > 0) ? -1 : 1;
      dims.push({ id: `con:${k}`, kind: "linear", a, b, side, text: fmt(c.v ?? dist2(a, b)), editable: true });
    } else if (P.kind === "circle") dims.push({ id: `con:${k}`, kind: "diameter", c: [P.cx, P.cy], r: P.r, text: `Ø ${fmt(c.v ?? P.r * 2)}`, editable: true });
  });
  const pend = pendingProfile(d);
  if (pend) add(pend, "pending", false);
  const chain = d.cursor && d.poly.length ? [...d.poly, d.cursor] : d.poly;
  for (let j = 0; j + 1 < chain.length; j++) {
    dims.push({ id: `chain:${j}`, kind: "linear", a: chain[j], b: chain[j + 1], side: 1, text: fmt(dist2(chain[j], chain[j + 1])), editable: false });
  }
  if (d.autoHint && d.cursor && d.poly.length) {
    const a = d.poly[d.poly.length - 1];
    const glyph = CONSTRAINTS.find((x) => x.kind === d.autoHint!.kind)!.glyph;
    const o = 16 / ppu;
    dims.push({ id: "autohint", kind: "label", at: [(a[0] + d.cursor[0]) / 2 - o, (a[1] + d.cursor[1]) / 2 + o], text: glyph, editable: false });
  }
  d.refDims.forEach((r, k) => {
    const g = refDimGeom(d, r);
    if (g && g.dist > 1e-6) dims.push({ id: `ref:${k}`, kind: "linear", a: g.Q, b: g.P, side: 1, offset: 0, text: fmt(g.dist), editable: true });
  });
  // Значки связей у обоих элементов, со сдвигом, чтобы не закрывать точку
  const off = 14 / ppu;
  d.constraints.forEach((c, k) => {
    // Авто-совпадения точек не подписываем — их много, и они очевидны
    if (c.auto && (c.kind === "coincident" || c.kind === "onLine")) return;
    if (c.kind === "length" || c.kind === "diameter") return; // это размеры — показаны числом
    const glyph = CONSTRAINTS.find((x) => x.kind === c.kind)!.glyph;
    for (const [tag, r] of (sameEnt(c.a, c.b) ? [["a", c.a]] : [["a", c.a], ["b", c.b]]) as [string, EntRef][]) {
      const at = entityAnchor(d.profiles, r);
      if (at) dims.push({ id: `con:${k}:${tag}`, kind: "label", at: [at[0] + off, at[1] + off], text: glyph, editable: false });
    }
  });
  return dims;
}

/** Текущее значение размера и функция, строящая профиль с новым значением */
function dimTarget(p: Profile, part: string): { value: number; apply: (v: number) => Profile } | null {
  if (p.kind === "rect" && part === "w") return { value: p.w, apply: (v) => ({ ...p, w: v }) };
  if (p.kind === "rect" && part === "h") return { value: p.h, apply: (v) => ({ ...p, h: v }) };
  if (p.kind === "circle") return { value: p.r * 2, apply: (v) => ({ ...p, r: v / 2 }) };
  if (p.kind === "ellipse" && part === "w") return { value: p.rx * 2, apply: (v) => ({ ...p, rx: v / 2 }) };
  if (p.kind === "ellipse" && part === "h") return { value: p.ry * 2, apply: (v) => ({ ...p, ry: v / 2 }) };
  if (p.kind === "slot" && part === "W") return { value: p.r * 2, apply: (v) => ({ ...p, r: v / 2 }) };
  if (p.kind === "slot" && part === "L") {
    const len = dist2(p.a, p.b);
    return { value: len, apply: (v) => ({ ...p, b: [p.a[0] + ((p.b[0] - p.a[0]) / len) * v, p.a[1] + ((p.b[1] - p.a[1]) / len) * v] }) };
  }
  if (p.kind === "poly" && part.startsWith("s")) {
    const j = Number(part.slice(1));
    const k = (j + 1) % p.pts.length;
    const [a, b] = [p.pts[j], p.pts[k]];
    const len = dist2(a, b);
    // Меняем длину отрезка, сдвигая его конечную точку вдоль направления
    return {
      value: len,
      apply: (v) => {
        const pts = [...p.pts];
        pts[k] = [a[0] + ((b[0] - a[0]) / len) * v, a[1] + ((b[1] - a[1]) / len) * v];
        return { ...p, pts };
      },
    };
  }
  return null;
}

/** Размер «точка — грань»: изменение сдвигает весь профиль перпендикулярно опорной линии */
function refDimTarget(d: Draft, k: number): { i: number; value: number; apply: (v: number) => Profile; allowZero: true } | null {
  const r = d.refDims[k];
  const g = r && refDimGeom(d, r);
  if (!g) return null;
  const [a, b] = r.ref;
  const len = dist2(a, b) || 1;
  const dir: V2 = g.dist > 1e-9 ? [(g.P[0] - g.Q[0]) / g.dist, (g.P[1] - g.Q[1]) / g.dist] : [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
  return {
    i: r.i,
    value: g.dist,
    apply: (v) => translateProfile(d.profiles[r.i], dir[0] * (v - g.dist), dir[1] * (v - g.dist)),
    allowZero: true,
  };
}

/** Размеры «точка — грань» держат своё значение: профиль сдвигается обратно */
function applyRefDims(d: Draft) {
  d.refDims.forEach((r, k) => {
    if (r.v === undefined) return;
    const t = refDimTarget(d, k);
    if (t && Math.abs(t.value - r.v) > 1e-6) d.profiles[t.i] = t.apply(r.v);
  });
}

/** Касание подписи размера — поле ввода на её месте; пустое значение удаляет размер */
view.onDimEdit = (id, label) => {
  const d = draft;
  if (!d) return;
  const [key, part] = id.split(":");
  const k = Number(part);
  let value: number;
  let allowZero = false;
  let commit: (v: number | null) => void;
  if (key === "con") {
    const c = d.constraints[k];
    if (!c) return;
    value = c.v ?? 0;
    commit = (v) => {
      keepStep(d);
      if (v === null) d.constraints.splice(k, 1);
      else c.v = v;
    };
  } else if (key === "ref") {
    const r = d.refDims[k];
    const g = r && refDimGeom(d, r);
    if (!g) return;
    value = g.dist;
    allowZero = true;
    commit = (v) => {
      keepStep(d);
      if (v === null) d.refDims.splice(k, 1);
      else {
        r.v = v;
        applyRefDims(d);
      }
    };
  } else return;
  const input = el("input", { type: "text", inputMode: isTouchLike() ? "none" : "decimal", autocomplete: "off", className: "dim-input", value: fmt(value) });
  input.dataset.num = "";
  input.style.transform = label.style.transform;
  label.style.visibility = "hidden";
  label.parentElement!.append(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (ok: boolean) => {
    if (done) return;
    done = true;
    input.remove();
    label.style.visibility = "";
    if (ok) {
      if (!input.value.trim()) {
        commit(null);
        toast("Размер удалён");
      } else {
        const v = evalExpr(input.value) ?? NaN;
        if (allowZero ? v >= 0 : v > 0) commit(v);
        else toast("Размер должен быть больше нуля", true);
      }
    }
    renderProps();
    drawDraft();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
};

/** Размер элемента (длина отрезка или диаметр окружности) — связь со значением */
function addDim(d: Draft, ent: EntRef) {
  const kind: ConstraintKind = ent.t === "line" ? "length" : "diameter";
  if (d.constraints.some((c) => c.kind === kind && sameEnt(c.a, ent))) return toast("Размер уже нанесён — коснитесь числа, чтобы изменить");
  const P = d.profiles[ent.i];
  const v = ent.t === "line" ? dist2(...lineOf(d.profiles, ent)) : P.kind === "circle" ? P.r * 2 : 0;
  if (!(v > 0)) return;
  keepStep(d);
  d.constraints.push({ kind, a: ent, b: ent, v: +v.toFixed(4) });
  haptic("tick");
  renderProps();
}

/** Связи эскиза нельзя выполнить все сразу */
let sketchConflict = false;

function drawDraft() {
  const d = draft;
  if (!d) return;
  // Связи восстанавливаются после любой правки; точка под пальцем остаётся на месте
  // Все связи и размеры решаются вместе; точка под пальцем следует за ним, насколько позволяют связи
  sketchConflict = !solve(d.profiles, d.constraints, d.drag ? { i: d.drag.i, h: d.drag.h } : null, d.refDims);
  const open: V2[][] = [];
  if (d.poly.length) open.push(d.cursor ? [...d.poly, d.cursor] : d.poly);
  if (d.stroke && d.stroke.length > 1) open.push(d.stroke);
  if (d.tool === "slot" && d.start && d.cursor && !d.slotLine) open.push([d.start, d.cursor]);
  const pend = pendingProfile(d);
  if (pend) {
    const pts = outline(pend);
    open.push([...pts, pts[0]]);
  }
  const showHandles = d.tool === "select" || d.tool === "dim" || d.tool === "constraint";
  const hl = [d.sel, d.dimFirst].filter(Boolean).map((r) => handles(d.profiles[r!.i])[r!.h]);
  // Первый выбранный элемент связи подсвечиваем
  const cf = d.conFirst;
  if (cf && cf.i === ORIGIN) {
    const L = 2000;
    if (cf.t === "pt") hl.push([0, 0]);
    else open.push(cf.e === 0 ? [[-L, 0], [L, 0]] : [[0, -L], [0, L]]);
  } else if (cf && isValidRef(d.profiles, cf)) {
    if (cf.t === "pt") hl.push(handles(d.profiles[cf.i])[cf.e]);
    else if (cf.t === "line") open.push(lineOf(d.profiles, cf));
    else {
      const o = outline(d.profiles[cf.i]);
      open.push([...o, o[0]]);
    }
  }
  view.setDraft({
    closed: d.profiles,
    open,
    marker: d.cursor,
    markerHot: d.cursorHot,
    dims: sketchDims(d),
    handles: showHandles ? d.profiles.flatMap((p) => handles(p)) : [],
    selected: hl,
    refLines: d.tool === "dim" ? d.refLines : [],
    hover: d.hoverEnt ?? undefined,
  });
  // Перетаскиваемый профиль не должен прилипать сам к себе
  const snapFrom = d.profiles.filter((_, i) => i !== d.drag?.i);
  const SNAP_NAMES = { end: "конец", mid: "середина", center: "центр", quad: "квадрант" } as const;
  const typed = snapFrom.flatMap(snapPointsTyped);
  const curves = snapFrom.flatMap((q) => (q.kind === "circle" || q.kind === "ellipse" || q.kind === "slot" ? [outline(q)] : []));
  const curveSegs = curves.flatMap((o) => o.map((a, i) => [a, o[(i + 1) % o.length]] as [V2, V2]));
  view.setSnapTargets(
    [[0, 0], ...typed.map((t) => t.p), ...d.poly, ...d.bodySnaps.points],
    ["начало координат", ...typed.map((t) => SNAP_NAMES[t.k]), ...d.poly.map(() => "точка линии"), ...d.bodySnaps.kinds],
    [...snapFrom.flatMap(segments), ...curveSegs, ...d.bodySnaps.lines],
  );

  // Живые размеры в строке состояния
  const autoName: Record<string, string> = { horizontal: "горизонтально", vertical: "вертикально", parallel: "параллельно", perpendicular: "перпендикулярно" };
  if (sketchConflict) status("⚠ Связи или размеры противоречат друг другу — уберите лишнюю (последнюю — «Шаг назад»)");
  else if (d.tool === "dim" && d.dimFirst) status("Теперь коснитесь ребра тела или оси (зелёные линии)");
  else if (d.autoHint && d.poly.length && d.cursor)
    status(`Авто: ${autoName[d.autoHint.kind]} · отрезок ${fmt(dist2(d.poly[d.poly.length - 1], d.cursor))} мм`);
  else if (d.snapKind && d.cursor && !pend) status(`Привязка: ${d.snapKind} · X ${fmt(d.cursor[0])} Y ${fmt(d.cursor[1])}`);
  else if (pend?.kind === "rect") status(`Прямоугольник ${fmt(pend.w)} × ${fmt(pend.h)} мм`);
  else if (pend?.kind === "circle") status(`Окружность R ${fmt(pend.r)} мм (Ø ${fmt(pend.r * 2)})`);
  else if (pend?.kind === "ellipse") status(`Эллипс ${fmt(pend.rx * 2)} × ${fmt(pend.ry * 2)} мм`);
  else if (pend?.kind === "slot") status(`Паз: длина ${fmt(dist2(pend.a, pend.b))}, ширина ${fmt(pend.r * 2)} мм`);
  else if (d.poly.length && d.cursor) status(`Отрезок ${fmt(dist2(d.poly[d.poly.length - 1], d.cursor))} мм`);
  else if (d.cursor) status(`X ${fmt(d.cursor[0])}  Y ${fmt(d.cursor[1])}`);
}

/** Элемент эскиза под курсором: точка, отрезок или кривая (окружность, эллипс, паз) */
function entityUnder(d: Draft, raw: V2): { pts: V2[]; lines: V2[][] } | null {
  const tol = 14 / view.pxPerUnit();
  const h = nearestHandle(d, raw, 14);
  if (h) return { pts: [handles(d.profiles[h.i])[h.h]], lines: [] };
  let best: V2[] | null = null;
  let bestD = tol;
  for (const p of d.profiles) {
    if (p.kind === "circle" || p.kind === "ellipse" || p.kind === "slot") {
      const o = outline(p);
      const loop = [...o, o[0]];
      for (let i = 0; i + 1 < loop.length; i++) {
        const dd = dist2(raw, closestOnSegment(raw, loop[i], loop[i + 1]));
        if (dd < bestD) [best, bestD] = [loop, dd];
      }
    } else {
      for (const [a, b] of conLines(p)) {
        const dd = dist2(raw, closestOnSegment(raw, a, b));
        if (dd < bestD) [best, bestD] = [[a, b], dd];
      }
    }
  }
  return best ? { pts: [], lines: [best] } : null;
}

/** Ортогональный режим: от предыдущей точки — строго по горизонтали или вертикали */
function orthoSnap(d: Draft, p: V2): V2 {
  const anchor = d.tool === "line" ? d.poly[d.poly.length - 1] : (d.tool === "axis" || d.tool === "slot") && !d.slotLine ? d.start : null;
  if (!d.ortho || !anchor) return p;
  return Math.abs(p[0] - anchor[0]) >= Math.abs(p[1] - anchor[1]) ? [p[0], anchor[1]] : [anchor[0], p[1]];
}

let lastSnapKey = "";

view.onSketch = (type, p0, hot, raw, snap) => {
  const d = draft;
  if (!d) return;
  let p = orthoSnap(d, p0);
  const auto = autoAlign(d, p, hot);
  if (auto) p = auto.p;
  d.autoHint = auto;
  d.cursor = p;
  d.cursorHot = hot;
  // Отклик пером: новая точка привязки
  const snapKey = snap ? `${snap}:${p[0]}:${p[1]}` : "";
  if (snapKey && snapKey !== lastSnapKey) haptic("tick");
  lastSnapKey = snapKey;
  d.snapKind = snap;
  d.hoverEnt = type === "hover" || type === "move" ? (d.drag ? null : entityUnder(d, raw)) : null;
  if (type === "cancel") {
    if (d.drag) d.profiles[d.drag.i] = d.drag.orig;
    d.drag = null;
    d.stroke = null;
    d.start = null;
    d.pressStarted = false;
  } else if (d.tool === "select") {
    if (type === "down") {
      const hit = nearestHandle(d, raw);
      d.sel = hit;
      if (hit && isFixedPoint(d, hit)) {
        d.drag = null;
        toast("⚓ Точка закреплена — снимите закрепление, чтобы двигать");
      } else {
        if (hit) keepStep(d);
        d.drag = hit && { ...hit, orig: d.profiles[hit.i] };
      }
      renderProps();
    } else if (type === "move" && d.drag) {
      d.profiles[d.drag.i] = moveHandle(d.drag.orig, d.drag.h, p);
    } else if (type === "up" && d.drag) {
      // Касание без движения — не шаг истории
      if (d.undo.length && JSON.parse(d.undo[d.undo.length - 1]).profiles[d.drag.i] && JSON.stringify(d.profiles[d.drag.i]) === JSON.stringify(d.drag.orig)) d.undo.pop();
      d.drag = null;
      renderProps();
    }
  } else if (d.tool === "free") {
    const unit = 1 / view.pxPerUnit();
    if (type === "down") d.stroke = [raw];
    else if (type === "move" && d.stroke) {
      if (dist2(raw, d.stroke[d.stroke.length - 1]) > unit * 1.5) d.stroke.push(raw);
    } else if (type === "up" && d.stroke) {
      d.stroke.push(raw);
      const step = view.gridSnap ? view.snapStep() : 0.01;
      const rec = recognize(d.stroke, unit, (q) => snapFree(d, q), (v) => Math.max(step, Math.round(v / step) * step));
      d.stroke = null;
      if (rec && isValid(rec.profile)) {
        commitProfile(rec.profile);
        toast(`✍ ${rec.name}`);
      } else toast("Не распознал фигуру — нарисуйте крупнее одним движением");
    }
  } else if (d.tool === "constraint") {
    if (type === "up") addConstraintTap(d, raw);
  } else if (d.tool === "dim") {
    if (type === "up") {
      const hit = nearestHandle(d, raw, 14);
      const line = !hit && d.dimFirst ? nearestRefLine(d, raw) : null;
      if (hit) {
        d.dimFirst = hit;
        status("Теперь коснитесь ребра тела или оси (зелёные линии)");
      } else if (line && d.dimFirst) {
        keepStep(d);
        const r: RefDim = { ...d.dimFirst, ref: line };
        r.v = +(refDimGeom(d, r)?.dist ?? 0).toFixed(4);
        d.refDims.push(r);
        d.dimFirst = null;
      } else {
        d.dimFirst = null;
        const ent = pickEntity(d.profiles, raw, 18 / view.pxPerUnit(), ["line", "circle"]);
        if (ent) addDim(d, ent);
        else toast("Коснитесь отрезка или окружности — появится размер. Точка, затем зелёная линия — размер до ребра");
      }
    }
  } else if (d.tool === "line") {
    if (type === "up") {
      const first = d.poly[0];
      const last = d.poly[d.poly.length - 1];
      if (first && d.poly.length >= 3 && dist2(p, first) < 1e-9) {
        commitProfile({ kind: "poly", pts: d.poly }, true);
        d.poly = [];
      } else if (!last || dist2(p, last) > 1e-9) {
        keepStep(d);
        if (auto && last) d.pend.push({ kind: auto.kind, seg: d.poly.length - 1, ref: auto.ref });
        d.poly.push(p);
      }
    }
  } else if (d.tool === "slot" && d.slotLine) {
    // Третий шаг паза: касание фиксирует ширину
    if (type === "up") {
      const prof = pendingProfile(d)!;
      if (isValid(prof)) commitProfile(prof);
      d.slotLine = null;
    }
  } else if (type === "down") {
    d.pressStarted = !d.start;
    if (!d.start) d.start = p;
  } else if (type === "up" && d.start) {
    // Касание без движения поставило только первую точку — ждём второе касание
    if (!(d.pressStarted && dist2(p, d.start) < 1e-9)) {
      if (d.tool === "slot") {
        if (dist2(d.start, p) > 1e-9) {
          d.slotLine = [d.start, p];
          status("Отведите палец, задавая ширину паза, и коснитесь");
        }
      } else {
        const prof = pendingProfile(d);
        if (prof && isValid(prof)) commitProfile(prof);
      }
      d.start = null;
    }
    d.pressStarted = false;
  }
  drawDraft();
  // Решатель мог сдвинуть фигуры — числа в панели должны совпадать с картинкой
  if (type === "up") renderProps();
};

/** Касание в инструменте «Связи»: первый элемент, затем второй — связь создаётся */
function addConstraintTap(d: Draft, raw: V2) {
  const def = CONSTRAINTS.find((c) => c.kind === d.conKind)!;
  const tol = 18 / view.pxPerUnit();
  let kinds = d.conFirst ? def.second : def.first;
  // Касание: к отрезку — окружность, к окружности — отрезок или окружность
  if (d.conKind === "tangent" && d.conFirst) kinds = d.conFirst.t === "line" ? ["circle"] : ["circle", "line"];
  // Равенство: отрезок — с отрезком, окружность — с окружностью
  if (d.conKind === "equal" && d.conFirst) kinds = [d.conFirst.t];
  // Начало координат и оси — для связей, где второй элемент может быть опорным
  const withOrigin = ["parallel", "perpendicular", "collinear", "tangent", "coincident", "onLine"].includes(d.conKind);
  const hit = pickEntity(d.profiles, raw, tol, kinds, withOrigin);
  if (!hit) return toast(def.hint);
  if (!def.second.length) {
    if (hit.i === ORIGIN) return toast(def.hint);
    // Связь одного элемента (горизонталь, вертикаль, закрепление)
    if (d.conKind === "fix" && isFixedPoint(d, { i: hit.i, h: hit.e })) return toast("Точка уже закреплена");
    keepStep(d);
    const c: Constraint = { kind: d.conKind, a: hit, b: hit };
    if (c.kind === "fix") c.p = [...handles(d.profiles[hit.i])[hit.e]] as V2;
    d.constraints.push(...prepareProfiles(d.profiles, c), c);
    haptic("tick");
    return renderProps();
  }
  if (!d.conFirst) {
    d.conFirst = hit;
    status("Теперь коснитесь второго элемента");
    return;
  }
  const a = d.conFirst;
  d.conFirst = null;
  if (a.i === hit.i && a.e === hit.e && a.t === hit.t) return toast("Нужны два разных элемента");
  if (a.i === ORIGIN && hit.i === ORIGIN) return toast("Нужен хотя бы один элемент эскиза");
  keepStep(d);
  const c: Constraint = { kind: d.conKind, a, b: hit };
  d.constraints.push(...prepareProfiles(d.profiles, c), c);
  haptic("tick");
  renderProps();
}

/** Точка закреплена связью «Закрепить» */
function isFixedPoint(d: Draft, r: { i: number; h: number }) {
  return d.constraints.some((c) => c.kind === "fix" && c.a.i === r.i && c.a.e === r.h);
}

function toggleFix(d: Draft, i: number, h: number) {
  keepStep(d);
  const k = d.constraints.findIndex((c) => c.kind === "fix" && c.a.i === i && c.a.e === h);
  if (k >= 0) d.constraints.splice(k, 1);
  else d.constraints.push({ kind: "fix", a: { i, e: h, t: "pt" }, b: { i, e: h, t: "pt" }, p: [...handles(d.profiles[i])[h]] as V2 });
  renderProps();
  drawDraft();
}

function stepBack() {
  const d = draft;
  if (!d) return;
  if (d.slotLine) d.slotLine = null;
  else if (d.start) d.start = null;
  else if (d.undo.length) restoreSnap(d, d.undo.pop()!);
  else if (d.poly.length) {
    d.poly.pop();
    d.pend = d.pend.filter((pc) => pc.seg < d.poly.length - 1);
  } else return toast("Нечего отменять");
  renderProps();
  drawDraft();
}

function closePoly() {
  const d = draft;
  if (!d || d.poly.length < 3) return toast("Нужно минимум 3 точки");
  commitProfile({ kind: "poly", pts: d.poly }, true);
  d.poly = [];
  drawDraft();
}

function finishSketch() {
  const d = draft!;
  keepOpenPoly(d);
  exitSketchMode();
  if (!d.profiles.length) {
    if (d.sketchId) doc.change({ removeSketches: [d.sketchId] });
    else refresh();
    return;
  }
  const id = d.sketchId ?? doc.newId();
  const sk: Sketch = {
    id,
    name: d.name || `Эскиз ${id}`,
    plane: d.plane,
    profiles: d.profiles,
    hostBodyId: d.hostBodyId,
    refDims: d.refDims,
    constraints: d.constraints.filter((c) => isValidRef(d.profiles, c.a) && isValidRef(d.profiles, c.b)),
  };
  // Сразу выбираем последний профиль — можно тянуть стрелку. Если он разрезан
  // пересечениями на области — пусть пользователь сам коснётся нужных
  const last = d.profiles.length - 1;
  const regions = sketchRegions(d.profiles);
  const whole = regions.some((r) => r.profile === last);
  selProfile = whole ? { sketchId: id, index: last } : null;
  ex.mode = "auto";
  doc.action = d.sketchId ? "Правка эскиза" : "Эскиз";
  doc.change({ sketches: [sk] });
  doc.action = undefined;
  if (!whole && regions.some((r) => r.profile === undefined))
    status("Контуры пересекаются — коснитесь областей, которые нужно вытянуть (можно несколько)");
}

function cancelSketch() {
  exitSketchMode();
  refresh();
}

function exitSketchMode() {
  mode = "normal";
  draft = null;
  view.exitSketch();
  status("");
}

function deleteProfile(ref: ProfileRef) {
  const sk = doc.getSketch(ref.sketchId);
  if (!sk) return;
  selProfile = null;
  const profiles = sk.profiles.filter((_, i) => i !== ref.index);
  const refDims = (sk.refDims ?? []).filter((r) => r.i !== ref.index).map((r) => (r.i > ref.index ? { ...r, i: r.i - 1 } : r));
  if (profiles.length) doc.change({ sketches: [{ ...sk, profiles, refDims }] });
  else doc.change({ removeSketches: [sk.id] });
}

// ---------- вытягивание ----------
interface ExtrudeOpts {
  /** Вытягивание или тело вращения вокруг оси эскиза */
  op?: "extrude" | "revolve";
  angle?: number;
  /** Номер оси (профиля kind:"axis") в эскизе */
  axisIndex?: number;
  distance: number;
  /** В обе стороны от плоскости эскиза на distance */
  symmetric?: boolean;
  mode: "auto" | "new" | "add" | "cut";
  targetId?: number;
}
const ex: ExtrudeOpts = { distance: 20, mode: "auto" };
let distInput: HTMLInputElement | null = null;
let opBox: HTMLElement | null = null;

function profileRefValid(ref: ProfileRef) {
  const sk = doc.getSketch(ref.sketchId);
  if (!sk) return false;
  if (!ref.regions) return !!sk.profiles[ref.index];
  const n = sketchRegions(sk.profiles).length;
  return ref.regions.length > 0 && ref.regions.every((r) => r < n);
}

/** Выбранные авто-области как один профиль (соседние сольются в ядре) */
let regionMemo: { key: string; profiles: Profile[]; prof: Profile } | null = null;
function regionProfile(sk: Sketch, regions: number[]): Profile | null {
  const key = `${sk.id}:${regions.join(",")}`;
  if (regionMemo && regionMemo.key === key && regionMemo.profiles === sk.profiles) return regionMemo.prof;
  const all = sketchRegions(sk.profiles);
  const chosen = regions.map((r) => all[r]).filter(Boolean);
  if (!chosen.length) return null;
  const prof: Profile = {
    kind: "region",
    parts: chosen.map((r) => ({ outer: r.outer.segs, holes: r.holes.map((h) => h.segs) })),
    pts: chosen.flatMap((r) => r.outer.pts),
  };
  regionMemo = { key, profiles: sk.profiles, prof };
  return prof;
}

function extrudeCtx() {
  if (mode !== "normal" || !selProfile) return null;
  const sk = doc.getSketch(selProfile.sketchId);
  if (!sk) return null;
  const prof = selProfile.regions ? regionProfile(sk, selProfile.regions) : sk.profiles[selProfile.index];
  return prof ? { sk, prof } : null;
}

/** Оси эскиза (для вращения) */
function sketchAxes(sk: Sketch) {
  return sk.profiles.map((p, i) => ({ p, i })).filter((x): x is { p: Extract<Profile, { kind: "axis" }>; i: number } => x.p.kind === "axis");
}

/**
 * Ось не должна пересекать профиль: ядро тогда строит самопересекающееся тело
 * (это ограничение OpenCascade) — проверяем заранее.
 */
function axisCrossesProfile(prof: Profile, a: V2, b: V2): boolean {
  const side = (q: V2) => (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
  const signs = outline(prof).map(side);
  const eps = 1e-6;
  return signs.some((v) => v > eps) && signs.some((v) => v < -eps);
}

function revolveShape(sk: Sketch, prof: Profile): K.Shape {
  const axes = sketchAxes(sk);
  const ax = axes.find((x) => x.i === ex.axisIndex) ?? axes[0];
  if (!ax) throw new Error("В эскизе нет оси");
  if (axisCrossesProfile(prof, ax.p.a, ax.p.b)) throw new Error("Ось пересекает профиль");
  return K.revolveProfile(sk.plane, prof, ax.p.a, ax.p.b, ex.angle ?? 360);
}

/** Во что превратится вытягивание: новое тело, добавление к телу или вырез */
function resolveOp(sk: Sketch): { kind: "new" | "add" | "cut"; target?: Body } {
  if (ex.mode === "auto") {
    const host = sk.hostBodyId !== undefined ? doc.get(sk.hostBodyId) : undefined;
    if (!host || host.locked || host.hidden) return { kind: "new" };
    return { kind: ex.distance >= 0 ? "add" : "cut", target: host };
  }
  if (ex.mode === "new") return { kind: "new" };
  const editable = doc.bodies.filter((b) => !b.locked && !b.hidden);
  const chosen = doc.get(ex.targetId ?? sk.hostBodyId ?? -1);
  const target = chosen && !chosen.locked && !chosen.hidden ? chosen : editable[0];
  return target ? { kind: ex.mode, target } : { kind: "new" };
}

const OP_TEXT = { new: "Новое тело", add: "Добавить к", cut: "Вырезать из" };

let previewQueued = false;
let lastPreview = 0;
const HEAVY_PREVIEW_MS = 90;

function schedulePreview() {
  if (previewQueued) return;
  previewQueued = true;
  // Скругление и вращение в ядре дороже вытягивания — пересчитываем реже
  const heavy = !!edgeCtx() || !!faceCtx() || ex.op === "revolve";
  const wait = heavy ? Math.max(0, HEAVY_PREVIEW_MS - (performance.now() - lastPreview)) : 0;
  setTimeout(
    () =>
      requestAnimationFrame(() => {
        previewQueued = false;
        lastPreview = performance.now();
        updatePreview();
      }),
    wait,
  );
}

function updatePreview() {
  const ectx = edgeCtx();
  if (ectx) return updateEdgePreview(ectx);
  const fctx = faceCtx();
  if (fctx) return updateFacePreview(fctx);
  const ctx = extrudeCtx();
  if (!ctx) return view.setPreview(null);
  const op = resolveOp(ctx.sk);
  if (distInput && document.activeElement !== distInput) distInput.value = fmt(ex.distance);
  if (opBox) {
    opBox.className = `op ${op.kind}`;
    opBox.textContent = `→ ${OP_TEXT[op.kind]}${op.target ? " «" + op.target.name + "»" : ""}`;
  }
  if (!isClosed(ctx.prof)) return view.setPreview(null);
  if (ex.op === "revolve") {
    try {
      view.setPreview(revolveShape(ctx.sk, ctx.prof), op.kind === "cut" ? 0xff5d5d : 0x5dd39e);
    } catch (err) {
      view.setPreview(null);
      if (opBox) {
        opBox.className = "op cut";
        opBox.textContent = (err as Error).message === "Ось пересекает профиль" ? "⚠ Ось пересекает профиль — ядро не построит такое тело. Отодвиньте ось или профиль." : `⚠ ${(err as Error).message}`;
      }
    }
    return;
  }
  if (Math.abs(ex.distance) < 1e-6) return view.setPreview(null);
  try {
    view.setPreview(K.extrudeProfile(ctx.sk.plane, ctx.prof, ex.distance, ex.symmetric), op.kind === "cut" ? 0xff5d5d : 0x5dd39e);
  } catch {
    view.setPreview(null);
  }
}

/** Что делать с числом, введённым в подпись у стрелки, — задаётся текущим контекстом */
let handleSetter: ((v: number) => void) | null = null;

view.onHandleEdit = (label, value) => {
  if (handleSetter) editValueAt(label, value, handleSetter);
};

/** Поле ввода поверх подписи на холсте; своя клавиатура на пальце/пере */
function editValueAt(label: HTMLElement, value: number, onCommit: (v: number) => void) {
  const input = el("input", { type: "text", inputMode: isTouchLike() ? "none" : "decimal", autocomplete: "off", className: "dim-input", value: fmt(value) });
  input.dataset.num = "";
  input.style.transform = label.style.transform;
  label.style.visibility = "hidden";
  label.parentElement!.append(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    input.remove();
    label.style.visibility = "";
    const v = evalExpr(input.value);
    if (commit && v !== null) onCommit(v);
    else if (commit) toast("Не понял число — пример: 40, 40+5, 4см", true);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function syncExtrude() {
  handleSetter = null;
  if (mode === "plane") return syncPlaneTool();
  view.setPlanePreview(null);
  // Скругление/фаска: стрелка на середине ребра, направлена внутрь тела
  const ectx = edgeCtx();
  if (ectx) {
    handleSetter = (v) => {
      if (!(v > 0)) return toast("Размер должен быть больше нуля", true);
      edgeSize = v;
      view.setHandleDistance(v);
      refresh();
    };
    view.showExtrudeHandle(
      ectx.frame.mid,
      ectx.frame.dir,
      edgeSize,
      (d) => {
        edgeSize = Math.max(0.1, Math.round(d * 10) / 10);
        schedulePreview();
      },
      () => (edgeKind === "fillet" ? `R ${fmt(edgeSize)}` : `Фаска ${fmt(edgeSize)}`),
    );
    schedulePreview();
    return;
  }
  const fctx = faceCtx();
  if (fctx) {
    handleSetter = (v) => {
      pp.distance = v;
      view.setHandleDistance(v);
      refresh();
    };
    view.showExtrudeHandle(
      fctx.frame.center,
      fctx.frame.normal,
      pp.distance,
      (d) => {
        pp.distance = Math.round(d * 100) / 100;
        schedulePreview();
      },
      (d) => `${d >= 0 ? "+" : ""}${fmt(d)} мм`,
    );
    schedulePreview();
    return;
  }
  const ctx = extrudeCtx();
  if (!ctx) {
    view.hideExtrudeHandle();
    view.setPreview(null);
    return;
  }
  // Для вращения и незамкнутых элементов стрелка не нужна
  if (ex.op === "revolve" || !isClosed(ctx.prof)) {
    view.hideExtrudeHandle();
    schedulePreview();
    return;
  }
  const origin = toWorld(ctx.sk.plane, centroid(ctx.prof));
  handleSetter = (v) => {
    ex.distance = v;
    view.setHandleDistance(v);
    refresh();
  };
  view.showExtrudeHandle(
    origin,
    ctx.sk.plane.normal,
    ex.distance,
    (d) => {
      ex.distance = Math.round(d * 100) / 100;
      schedulePreview();
    },
    (d) => (ex.symmetric ? `± ${fmt(Math.abs(d))} мм` : `${fmt(d)} мм`),
  );
  schedulePreview();
}

function applyExtrude() {
  const ctx = extrudeCtx();
  if (!ctx) return;
  if (!isClosed(ctx.prof)) return toast("Это не замкнутый контур — его нельзя вытянуть или повернуть", true);
  const revolve = ex.op === "revolve";
  if (!revolve && Math.abs(ex.distance) < 1e-6) return toast("Расстояние не может быть нулевым");
  if (revolve) {
    const ax = sketchAxes(ctx.sk);
    if (!ax.length) return toast("Добавьте в эскиз ось (инструмент «Ось»)", true);
    const a = ax.find((x) => x.i === ex.axisIndex) ?? ax[0];
    if (axisCrossesProfile(ctx.prof, a.p.a, a.p.b)) return warn("Ось пересекает профиль — OpenCascade не строит самопересекающиеся тела вращения. Отодвиньте ось.");
  }
  const op = resolveOp(ctx.sk);
  run(revolve ? "Вращение" : "Вытягивание", () => {
    const tool = revolve ? revolveShape(ctx.sk, ctx.prof) : K.extrudeProfile(ctx.sk.plane, ctx.prof, ex.distance, ex.symmetric);
    let result: Body;
    if (op.kind === "new" || !op.target) {
      result = doc.newBody({ shape: tool, offset: [0, 0, 0] });
      result.name = `${revolve ? "Вращение" : "Вытягивание"} ${result.id}`;
    } else {
      const shape = op.kind === "add" ? K.union(op.target.shape, tool) : K.subtract(op.target.shape, tool);
      result = { ...op.target, shape, prim: undefined };
    }
    selProfile = null;
    selection = [result.id];
    doc.replace([result]);
  });
}

// ---------- грани и рёбра ----------
const pp = { distance: 10 };
let edgeSize = 3;
let edgeKind: "fillet" | "chamfer" = "fillet";
let shellThickness = 2;

/** Выбраны только рёбра — доступно скругление/фаска со стрелкой */
/**
 * Запросы к ядру о гранях/рёбрах (нормали, середины) вызываются на каждое обновление
 * интерфейса — кэшируем по фигуре: фигуры неизменяемы, id граней в них стабильны.
 */
const frameCache = new WeakMap<K.Shape, Map<string, unknown>>();
function cached<T>(shape: K.Shape, key: string, fn: () => T): T {
  let m = frameCache.get(shape);
  if (!m) frameCache.set(shape, (m = new Map()));
  if (!m.has(key)) m.set(key, fn());
  return m.get(key) as T;
}

function edgeCtx() {
  if (mode !== "normal" || !sub || !sub.edges.length || sub.faces.length) return null;
  try {
    const frame = cached(sub.body.shape, `e${sub.edges[0]}`, () => K.edgeFrame(sub!.body.shape, sub!.edges[0]));
    return { body: sub.body, edges: sub.edges, frame };
  } catch {
    return null;
  }
}

/** Предпросмотр скругления: результат показывается вместо тела */
function updateEdgePreview(e: NonNullable<ReturnType<typeof edgeCtx>>) {
  if (distInput && document.activeElement !== distInput) distInput.value = fmt(edgeSize);
  try {
    const shape = K.edgeOp(e.body.shape, edgeKind, e.edges, edgeSize);
    view.setPreview(shape, parseInt(e.body.color.slice(1), 16), { opaque: true, hideBodyId: e.body.id });
    if (opBox) {
      opBox.className = "op add";
      opBox.textContent = `→ ${edgeKind === "fillet" ? "Скругление R" : "Фаска"} ${fmt(edgeSize)} мм`;
    }
  } catch {
    view.setPreview(null);
    if (opBox) {
      opBox.className = "op cut";
      opBox.textContent = "Размер слишком большой для этих рёбер";
    }
  }
}

/** Ровно одна плоская грань выбрана — доступен «тяни-толкай» со стрелкой */
function faceCtx() {
  if (mode !== "normal" || !sub || sub.faces.length !== 1 || sub.edges.length) return null;
  try {
    const frame = cached(sub.body.shape, `f${sub.faces[0]}`, () => K.faceFrame(sub!.body.shape, sub!.faces[0]));
    return frame.planar ? { body: sub.body, faceId: sub.faces[0], frame } : null;
  } catch {
    return null;
  }
}

function updateFacePreview(f: NonNullable<ReturnType<typeof faceCtx>>) {
  const kind = pp.distance >= 0 ? "add" : "cut";
  if (distInput && document.activeElement !== distInput) distInput.value = fmt(pp.distance);
  if (opBox) {
    opBox.className = `op ${kind}`;
    opBox.textContent = kind === "add" ? "→ Нарастить материал" : "→ Срезать материал";
  }
  if (Math.abs(pp.distance) < 1e-6) return view.setPreview(null);
  try {
    view.setPreview(K.facePrism(f.body.shape, f.faceId, pp.distance), kind === "cut" ? 0xff5d5d : 0x5dd39e);
  } catch {
    view.setPreview(null);
  }
}

/** Применить операцию к телу из выбора граней/рёбер; выбор сбрасывается — id меняются */
function applySub(label: string, fn: (b: Body) => K.Shape, failHint?: string) {
  const b = sub?.body;
  if (!b) return;
  run(
    label,
    () => {
      const shape = fn(b);
      sub = null;
      doc.replace([{ ...b, shape, prim: undefined }]);
    },
    failHint,
  );
}

function applyPushPull() {
  const f = faceCtx();
  if (!f) return;
  if (Math.abs(pp.distance) < 1e-6) return toast("Расстояние не может быть нулевым");
  applySub("Тяни-толкай", (b) => K.pushPull(b.shape, f.faceId, pp.distance));
}

function applyEdgeOp(kind: "fillet" | "chamfer" = edgeKind) {
  if (!(edgeSize > 0)) return toast("Укажите размер больше нуля");
  const edges = sub!.edges;
  applySub(kind === "fillet" ? "Скругление" : "Фаска", (b) => K.edgeOp(b.shape, kind, edges, edgeSize));
}

function applyShell() {
  if (!(shellThickness > 0)) return toast("Толщина должна быть больше нуля");
  const faces = sub!.faces;
  applySub(
    "Оболочка",
    (b) => K.shell(b.shape, faces, shellThickness),
    "Частично скруглённые тела ядро не обрабатывает — сделайте оболочку до скругления или уменьшите толщину",
  );
}

// ---------- вспомогательные плоскости ----------
type PlaneMethod = "offset" | "angle" | "points";
const planeTool = {
  method: "offset" as PlaneMethod,
  /** XY / XZ / YZ, "p:<id>" — своя плоскость, "face" — грань тела */
  base: "XY",
  facePlane: null as SketchPlane | null,
  dist: 20,
  angle: 45,
  axis: "x" as "x" | "y" | "edge",
  edge: null as [Vec3, Vec3] | null,
  pts: [] as Vec3[],
};

function beginPlane() {
  if (mode === "sketch") return;
  mode = "plane";
  selection = [];
  selProfile = null;
  sub = null;
  selPlane = null;
  planeTool.pts = [];
  refresh();
}

function exitPlaneTool() {
  mode = "normal";
  view.setPlanePreview(null);
  view.hideExtrudeHandle();
  status("");
}

function basePlane(): SketchPlane | null {
  const b = planeTool.base;
  if (b === "XY" || b === "XZ" || b === "YZ") return STD_PLANES[b];
  if (b === "face") return planeTool.facePlane;
  return doc.getPlane(Number(b.slice(2)))?.plane ?? null;
}

/** Плоскость, которая получится при текущих настройках */
function computePlane(): SketchPlane | null {
  const t = planeTool;
  if (t.method === "points") return t.pts.length === 3 ? plane3(t.pts[0], t.pts[1], t.pts[2]) : null;
  const base = basePlane();
  if (!base) return null;
  if (t.method === "offset") return offsetPlane(base, t.dist);
  if (t.axis === "edge") {
    if (!t.edge) return null;
    const [a, b] = t.edge;
    return anglePlane(base, a, [b[0] - a[0], b[1] - a[1], b[2] - a[2]], t.angle);
  }
  return anglePlane(base, base.origin, t.axis === "x" ? base.xDir : base.yDir, t.angle);
}

/** Что выбирается касанием в режиме создания плоскости */
function planeToolPickMode(): PickMode {
  const t = planeTool;
  if (t.method === "points") return "vertex";
  if (t.method === "angle" && t.axis === "edge") return "edge";
  return "face";
}

function syncPlaneTool() {
  const t = planeTool;
  const base = basePlane();
  // Для смещения — стрелка от базовой плоскости, тянется как вытягивание
  if (t.method === "offset" && base) {
    handleSetter = (v) => {
      t.dist = v;
      refresh();
    };
    view.showExtrudeHandle(
      base.origin,
      base.normal,
      t.dist,
      (d) => {
        t.dist = Math.round(d * 100) / 100;
        if (distInput && document.activeElement !== distInput) distInput.value = fmt(t.dist);
        view.setPlanePreview(computePlane());
      },
      (d) => `${fmt(d)} мм`,
    );
  } else view.hideExtrudeHandle();
  view.setPlanePreview(computePlane());
}

function planeToolTap(pick: Pick) {
  const t = planeTool;
  if (t.method === "points") {
    if (pick?.kind !== "vertex") return toast("Коснитесь вершины тела (угла)");
    t.pts = t.pts.length >= 3 ? [pick.at] : [...t.pts, pick.at];
    return refresh();
  }
  if (t.method === "angle" && t.axis === "edge") {
    if (pick?.kind !== "edge") return toast("Коснитесь прямого ребра тела");
    try {
      t.edge = K.edgeEnds(doc.get(pick.id)!.shape, pick.edgeId);
    } catch {
      return toast("Не удалось взять ребро", true);
    }
    return refresh();
  }
  if (pick?.kind === "plane") {
    t.base = `p:${pick.id}`;
    return refresh();
  }
  if (pick?.kind !== "face") return;
  const pl = K.facePlane(doc.get(pick.id)!.shape, pick.faceId);
  if (!pl) return toast("Нужна плоская грань", true);
  t.facePlane = pl;
  t.base = "face";
  refresh();
}

function createPlane() {
  const pl = computePlane();
  if (!pl) return toast("Плоскость ещё не задана", true);
  const id = doc.newId();
  exitPlaneTool();
  selPlane = id;
  doc.change({ planes: [{ id, name: `Плоскость ${doc.planes.length + 1}`, plane: pl }] });
}

function deletePlane(id: number) {
  if (selPlane === id) selPlane = null;
  doc.change({ removePlanes: [id] });
}

function renderPlaneTool(root: HTMLElement) {
  const t = planeTool;
  root.append(
    el("h3", { textContent: "Новая плоскость" }),
    segmented(
      [["offset", "Смещение"], ["angle", "Под углом"], ["points", "3 точки"]],
      t.method,
      (v) => {
        t.method = v as PlaneMethod;
        t.pts = [];
        refresh();
      },
    ),
  );
  if (t.method !== "points") {
    const opts: [string, string][] = [["XY", "Плоскость XY"], ["XZ", "Плоскость XZ"], ["YZ", "Плоскость YZ"], ...doc.planes.map((p) => [`p:${p.id}`, p.name] as [string, string])];
    if (t.facePlane) opts.push(["face", "Грань тела"]);
    root.append(
      selectField("От плоскости", opts, t.base, (v) => {
        t.base = v;
        refresh();
      }),
      el("p", { className: "hint", textContent: "Или коснитесь плоской грани тела / своей плоскости." }),
    );
  }
  if (t.method === "offset") {
    const f = numberField("Расстояние, мм", t.dist, (v) => {
      t.dist = v;
      refresh();
    });
    distInput = f.querySelector("input");
    root.append(f, el("p", { className: "hint", textContent: "Можно тянуть стрелку." }));
  }
  if (t.method === "angle") {
    root.append(
      selectField("Ось поворота", [["x", "Ось X базовой плоскости"], ["y", "Ось Y базовой плоскости"], ["edge", "Ребро тела"]], t.axis, (v) => {
        t.axis = v as typeof t.axis;
        refresh();
      }),
      numberField("Угол, °", t.angle, (v) => {
        t.angle = v;
        refresh();
      }),
    );
    if (t.axis === "edge") root.append(el("p", { className: "hint", textContent: t.edge ? "Ребро выбрано. Можно коснуться другого." : "Коснитесь прямого ребра тела — оно станет осью." }));
  }
  if (t.method === "points") {
    root.append(el("p", { className: "hint", textContent: `Коснитесь трёх вершин тел. Выбрано: ${t.pts.length} из 3.` }));
    if (t.pts.length === 3 && !computePlane()) root.append(el("p", { className: "hint", textContent: "Точки лежат на одной прямой — выберите другие." }));
  }
  root.append(
    buttonRow(["Создать", createPlane, "primary"], [
      "Отмена",
      () => {
        exitPlaneTool();
        refresh();
      },
    ]),
  );
}

function renderPlanePanel(root: HTMLElement, rp: RefPlane) {
  root.append(
    el("h3", { textContent: rp.name }),
    el("p", { className: "hint", textContent: "Вспомогательная плоскость для эскизов." }),
    buttonRow(["Эскиз на плоскости", () => startSketch(rp.plane), "primary"]),
    buttonRow(
      [
        "Переименовать",
        async () => {
          const v = await uiPrompt("Название плоскости", rp.name);
          const cur = doc.getPlane(rp.id);
          if (v && cur) doc.change({ planes: [{ ...cur, name: v }] });
        },
      ],
      ["Скрыть", () => ((selPlane = null), doc.change({ planes: [{ ...rp, hidden: true }] }))],
    ),
    buttonRow(["Удалить", () => deletePlane(rp.id)]),
  );
}

// ---------- команды ----------
const commands: Record<string, () => void> = {
  projects: () => showProjects(),
  "close-projects": closeProjects,
  rename: renameProject,
  "open-file": pickFile,
  import: pickFile,
  "save-file": () => saveFile(),
  theme: () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"),
  settings: () => showSettings($("[data-cmd=settings]")),
  panel: () => setPanelCollapsed(!$("#app").classList.contains("panel-collapsed")),
  history: () => setTimelineOpen($("#timeline").style.display === "none"),
  snap: () => applySnap(!view.gridSnap),
  "pick-auto": () => setPickMode("auto"),
  "pick-body": () => setPickMode("body"),
  "pick-face": () => setPickMode("face"),
  "pick-edge": () => setPickMode("edge"),
  sketch: beginSketch,
  plane: beginPlane,
  box: () => {
    view.setBoxSelect(!view.boxSelect);
    refresh();
    if (view.boxSelect) toast("Проведите рамку вокруг тел. Два пальца — сдвиг и масштаб вида");
  },
  "select-all": selectAll,
  cube: () => addPrimitive("box"),
  cylinder: () => addPrimitive("cylinder"),
  sphere: () => addPrimitive("sphere"),
  union: () => boolean("union"),
  subtract: () => boolean("subtract"),
  intersect: () => boolean("intersect"),
  multi: () => {
    multi = !multi;
    refresh();
  },
  duplicate,
  delete: remove,
  undo: () => (mode === "sketch" ? stepBack() : doc.undo()),
  redo: () => doc.redo(),
  fit: () => view.fit(),
  stl: () => exportFile("stl"),
  step: () => exportFile("step"),
};

// Делегирование: кнопки панели инструментов создаются и пересоздаются динамически
document.addEventListener("click", (e) => {
  const btn = (e.target as Element).closest<HTMLButtonElement>("button[data-cmd]");
  if (!btn || btn.disabled) return;
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const cmd = btn.dataset.cmd!;
  const group = btn.dataset.group;
  // Инструмент из группы становится её «лицом» — повторный вызов в одно касание
  if (group && getPref(`tool:${group}`) !== cmd) {
    setPref(`tool:${group}`, cmd);
    renderToolbar();
  }
  closeFlyout();
  commands[cmd]?.();
  updateToolbarState();
});

window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (!$("#projects").classList.contains("hidden")) {
    if (k === "escape") closeProjects();
    return;
  }
  if (!mod && k === "g") return applySnap(!view.gridSnap);
  if (mod && k === "s") {
    e.preventDefault();
    dirty = dirty || !!projectId;
    saveNow();
    return;
  }
  if (mode === "sketch") {
    if (mod && k === "z") stepBack();
    else if (k === "o") toggleOrtho();
    else if ((k === "delete" || k === "backspace") && draft?.sel) deleteSelectedPoint();
    else if (k === "escape") draft?.start || draft?.poly.length ? stepBack() : cancelSketch();
    else if (k === "enter") finishSketch();
    return;
  }
  if (mode === "pickPlane") {
    if (k === "escape") cancelSketch();
    return;
  }
  if (mode === "pickAxis") {
    if (k === "escape") pickArrayAxis(null);
    return;
  }
  if (mode === "plane") {
    if (k === "escape") {
      exitPlaneTool();
      refresh();
    }
    if (k === "enter") createPlane();
    return;
  }
  if (!mod && k === "h") return setTimelineOpen($("#timeline").style.display === "none");
  if (mod && k === "a") {
    e.preventDefault();
    return selectAll();
  }
  if (mod && k === "z") e.shiftKey ? doc.redo() : doc.undo();
  else if (mod && k === "y") doc.redo();
  else if (k === "delete" || k === "backspace") remove();
  else if (k === "escape") select(null);
  else if (k === "enter" && selProfile) applyExtrude();
  else if (k === "enter" && faceCtx()) applyPushPull();
  else if (k === "a" || k === "b" || k === "f" || k === "e") setPickMode(({ a: "auto", b: "body", f: "face", e: "edge" } as const)[k]);
});

view.onMoveEnd = moveBody;

// ---------- панель свойств ----------
function numberField(label: string, value: number, onCommit: (v: number) => void) {
  const row = document.createElement("div");
  row.className = "field";
  // Текст, а не number: можно вводить выражения «40+5», «4см»; data-num — своя клавиатура на планшете
  row.innerHTML = `<label></label><input type="text" inputmode="decimal" data-num autocomplete="off">`;
  row.querySelector("label")!.textContent = label;
  const input = row.querySelector("input")!;
  input.value = fmt(value);
  const commit = () => {
    const v = evalExpr(input.value);
    if (v === null) {
      input.value = fmt(value);
      return toast("Не понял число — пример: 40, 40+5, 4см", true);
    }
    input.value = fmt(v);
    if (v !== value) onCommit(v);
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => e.key === "Enter" && input.blur());
  return row;
}

/** Создать элемент со свойствами (style можно передать строкой) и детьми */
function el<T extends keyof HTMLElementTagNameMap>(tag: T, props: Record<string, unknown> = {}, ...children: (Node | string)[]) {
  const e: HTMLElementTagNameMap[T] = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

/** Переключатель из нескольких вариантов (один активный) */
function segmented(options: [string, string][], value: string, onChange: (v: string) => void) {
  const wrap = el("div", { className: "segmented" });
  for (const [v, text] of options) {
    const b = el("button", { textContent: text, className: v === value ? "on" : "" });
    b.addEventListener("click", () => v !== value && onChange(v));
    wrap.append(b);
  }
  return wrap;
}

function selectField(label: string, options: [string, string][], value: string, onChange: (v: string) => void) {
  const sel = el("select");
  for (const [v, t] of options) sel.append(el("option", { value: v, textContent: t, selected: v === value }));
  sel.addEventListener("change", () => onChange(sel.value));
  return el("div", { className: "field" }, el("label", { textContent: label }), sel);
}

function buttonRow(...btns: [string, () => void, string?][]) {
  return el(
    "div",
    { className: "row" },
    ...btns.map(([text, fn, cls]) => {
      const b = el("button", { textContent: text, className: cls ?? "" });
      b.addEventListener("click", fn);
      return b;
    }),
  );
}

function renderPickPlane(root: HTMLElement) {
  root.append(
    el("h3", { textContent: "Новый эскиз" }),
    el("p", { className: "hint", textContent: "Коснитесь плоской грани тела или выберите стандартную плоскость:" }),
    buttonRow(
      ["XY", () => startSketch(STD_PLANES.XY)],
      ["XZ", () => startSketch(STD_PLANES.XZ)],
      ["YZ", () => startSketch(STD_PLANES.YZ)],
    ),
  );
  const own = doc.planes.filter((pl) => !pl.hidden);
  if (own.length) {
    root.append(el("h3", { textContent: "Вспомогательные плоскости" }));
    for (const pl of own) root.append(buttonRow([pl.name, () => startSketch(pl.plane)]));
  }
  root.append(buttonRow(["Отмена", cancelSketch]));
}

/** Поля размеров профиля; изменение пересоздаёт профиль в черновике */
function profileFields(p: Profile, update: (p: Profile) => void): HTMLElement[] {
  const pos = (v: number) => v > 0 || (toast("Размер должен быть больше нуля", true), false);
  // Общий радиус скругления углов (для прямоугольника и многоугольника)
  const cornerField = (q: Profile & { radii?: number[] }) =>
    numberField("R всех углов", Math.max(0, ...(q.radii ?? [0])), (v) => v >= 0 && update(setCornerRadius(q, "all", v)));
  switch (p.kind) {
    case "rect":
      return [
        numberField("Ширина", p.w, (v) => pos(v) && update({ ...p, w: v })),
        numberField("Высота", p.h, (v) => pos(v) && update({ ...p, h: v })),
        numberField("X угла", p.x, (v) => update({ ...p, x: v })),
        numberField("Y угла", p.y, (v) => update({ ...p, y: v })),
        cornerField(p),
      ];
    case "circle":
      return [
        numberField("Радиус", p.r, (v) => pos(v) && update({ ...p, r: v })),
        numberField("X центра", p.cx, (v) => update({ ...p, cx: v })),
        numberField("Y центра", p.cy, (v) => update({ ...p, cy: v })),
      ];
    case "ellipse":
      return [
        numberField("Ширина", p.rx * 2, (v) => pos(v) && update({ ...p, rx: v / 2 })),
        numberField("Высота", p.ry * 2, (v) => pos(v) && update({ ...p, ry: v / 2 })),
        numberField("X центра", p.cx, (v) => update({ ...p, cx: v })),
        numberField("Y центра", p.cy, (v) => update({ ...p, cy: v })),
      ];
    case "slot":
      return [
        numberField("Ширина", p.r * 2, (v) => pos(v) && update({ ...p, r: v / 2 })),
        numberField("X1", p.a[0], (v) => update({ ...p, a: [v, p.a[1]] })),
        numberField("Y1", p.a[1], (v) => update({ ...p, a: [p.a[0], v] })),
        numberField("X2", p.b[0], (v) => update({ ...p, b: [v, p.b[1]] })),
        numberField("Y2", p.b[1], (v) => update({ ...p, b: [p.b[0], v] })),
      ];
    case "region":
      return [];
    case "poly":
      return [el("div", { className: "hint", textContent: `${p.pts.length} точек` }), cornerField(p)];
    case "path":
      return [el("div", { className: "hint", textContent: `Незамкнутые линии: ${p.pts.length - 1} отр. Не вытягиваются — замкните контур инструментом «Линия».` })];
    case "axis":
      return [
        numberField("X1", p.a[0], (v) => update({ ...p, a: [v, p.a[1]] })),
        numberField("Y1", p.a[1], (v) => update({ ...p, a: [p.a[0], v] })),
        numberField("X2", p.b[0], (v) => update({ ...p, b: [v, p.b[1]] })),
        numberField("Y2", p.b[1], (v) => update({ ...p, b: [p.b[0], v] })),
      ];
  }
}

/** Раздел выбранной точки: координаты, удаление, скругление угла */
function renderPointSection(root: HTMLElement, d: Draft) {
  const { i, h } = d.sel!;
  const p = d.profiles[i];
  const q = handles(p)[h];
  if (!q) return;
  const set = (np: Profile) => {
    keepStep(d);
    d.profiles[i] = np;
    renderProps();
    drawDraft();
  };
  const fixed = isFixedPoint(d, { i, h });
  root.append(
    el("h3", { textContent: `Точка — ${PROFILE_NAMES[p.kind].toLowerCase()} ${i + 1}` }),
    numberField("X", q[0], (v) => set(moveHandle(p, h, [v, q[1]]))),
    numberField("Y", q[1], (v) => set(moveHandle(p, h, [q[0], v]))),
    buttonRow(
      [fixed ? "⚓ Открепить" : "⚓ Закрепить", () => toggleFix(d, i, h)],
      [p.kind === "poly" || (p.kind === "rect" && h < 4) ? "Удалить точку" : "Удалить фигуру", deleteSelectedPoint],
    ),
  );
  if (isCorner(p, h)) {
    const cur = (p.kind === "rect" || p.kind === "poly" ? p.radii?.[h] : 0) ?? 0;
    const rField = numberField("Радиус скругления", cur || 3, () => {});
    const r = () => parseFloat(rField.querySelector("input")!.value.replace(",", ".")) || 0;
    root.append(
      rField,
      buttonRow(["Скруглить угол", () => set(setCornerRadius(p, h, r()))], ["Все углы", () => set(setCornerRadius(p, "all", r()))]),
    );
    if (corners(p).length && cur > 0) root.append(buttonRow(["Убрать скругление", () => set(setCornerRadius(p, h, 0))]));
  }
}

function toggleOrtho() {
  if (!draft) return;
  draft.ortho = !draft.ortho;
  toast(draft.ortho ? "Ортогональный режим включён" : "Ортогональный режим выключен");
  renderProps();
}

function renderConstraintSection(root: HTMLElement, d: Draft) {
  const grid = el("div", { className: "con-grid" });
  for (const c of CONSTRAINTS.filter((x) => !x.dim)) {
    const b = el("button", { className: d.conKind === c.kind ? "on" : "", title: c.hint }, el("span", { className: "ico", textContent: c.glyph }), c.label);
    b.addEventListener("click", () => {
      d.conKind = c.kind;
      d.conFirst = null;
      renderProps();
      drawDraft();
    });
    grid.append(b);
  }
  root.append(grid, el("p", { className: "hint", textContent: CONSTRAINTS.find((c) => c.kind === d.conKind)!.hint }));
  if (!d.constraints.length) return;
  root.append(el("h3", { textContent: `Связи (${d.constraints.length})` }));
  d.constraints.forEach((c, k) => {
    const def = CONSTRAINTS.find((x) => x.kind === c.kind)!;
    const del = el("button", { textContent: "✕", title: "Удалить связь" });
    del.addEventListener("click", () => {
      keepStep(d);
      d.constraints.splice(k, 1);
      renderProps();
      drawDraft();
    });
    const who = sameEnt(c.a, c.b) ? entName(c.a) : `${entName(c.a)} и ${entName(c.b)}`;
    const val = c.v !== undefined ? ` = ${c.kind === "diameter" ? "Ø" : ""}${fmt(c.v)}` : "";
    root.append(el("div", { className: "prof" }, el("div", { className: "prof-head" }, `${def.glyph} ${def.label}${val}: ${who}${c.auto ? " · авто" : ""}`, del)));
  });
}

/** Нанесённые размеры с удалением */
function renderDimSection(root: HTMLElement, d: Draft) {
  const list = d.constraints.map((c, k) => ({ c, k })).filter(({ c }) => c.kind === "length" || c.kind === "diameter");
  if (!list.length) return;
  root.append(el("h3", { textContent: `Размеры (${list.length})` }));
  for (const { c, k } of list) {
    const del = el("button", { textContent: "✕", title: "Удалить размер" });
    del.addEventListener("click", () => {
      keepStep(d);
      d.constraints.splice(k, 1);
      renderProps();
      drawDraft();
    });
    const text = c.kind === "length" ? `↔ ${fmt(c.v ?? 0)} мм — отрезок, ${entName(c.a)}` : `Ø ${fmt(c.v ?? 0)} мм — ${entName(c.a)}`;
    root.append(el("div", { className: "prof" }, el("div", { className: "prof-head" }, text, del)));
  }
}

function renderSketchPanel(root: HTMLElement) {
  const d = draft!;
  const tools = el("div", { className: "tools" });
  for (const t of TOOLS) {
    const b = el("button", { className: d.tool === t.id ? "on" : "", title: t.label }, el("span", { className: "ico", textContent: t.ico }), t.label);
    b.addEventListener("click", () => setTool(t.id));
    tools.append(b);
  }
  root.append(el("h3", { textContent: "Эскиз" }), tools, el("p", { className: "hint", textContent: TOOLS.find((t) => t.id === d.tool)!.hint }));
  const orthoBtn = el("button", { className: d.ortho ? "on" : "", textContent: "⊾ Орто", title: "Ортогональный режим (O): отрезки строго по горизонтали/вертикали" });
  orthoBtn.addEventListener("click", () => toggleOrtho());
  const autoBtn = el("button", {
    className: d.autoCon ? "on" : "",
    textContent: "⚡ Авто-связи",
    title: "При рисовании: горизонталь, вертикаль, параллельность и соединение точек ставятся сами",
  });
  autoBtn.addEventListener("click", () => {
    d.autoCon = !d.autoCon;
    setPref("autoCon", d.autoCon ? "1" : "0");
    toast(d.autoCon ? "Авто-связи включены" : "Авто-связи выключены");
    renderProps();
  });
  root.append(el("div", { className: "row" }, orthoBtn, autoBtn));
  if (d.tool === "line") root.append(buttonRow(["Замкнуть", closePoly], ["↶ Шаг назад", stepBack]));
  else root.append(buttonRow(["↶ Шаг назад", stepBack]));
  if (d.tool === "dim" && d.refDims.length) {
    root.append(
      buttonRow([
        `Убрать размеры до граней (${d.refDims.length})`,
        () => {
          keepStep(d);
          d.refDims = [];
          renderProps();
          drawDraft();
        },
      ]),
    );
  }
  if (d.tool === "select" && d.sel && d.profiles[d.sel.i]) renderPointSection(root, d);
  if (d.tool === "constraint") renderConstraintSection(root, d);
  if (d.tool === "dim") renderDimSection(root, d);

  root.append(el("h3", { textContent: `Профили (${d.profiles.length})` }));
  d.profiles.forEach((p, i) => {
    const del = el("button", { textContent: "✕", title: "Удалить" });
    del.addEventListener("click", () => {
      keepStep(d);
      removeProfileAt(i);
      renderProps();
      drawDraft();
    });
    const box = el("div", { className: "prof" }, el("div", { className: "prof-head" }, `${PROFILE_NAMES[p.kind]} ${i + 1}`, del));
    box.append(
      ...profileFields(p, (np) => {
        keepStep(d);
        d.profiles[i] = np;
        renderProps();
        drawDraft();
      }),
    );
    root.append(box);
  });
  if (!d.profiles.length) root.append(el("p", { className: "hint", textContent: "Нарисуйте контур пальцем или стилусом. Два пальца — сдвиг и масштаб вида." }));
  root.append(buttonRow(["Готово", finishSketch, "primary"], ["Отмена", cancelSketch]));
}

function renderExtrudePanel(root: HTMLElement, sk: Sketch, prof: Profile) {
  if (!isClosed(prof)) {
    root.append(
      el("h3", { textContent: `${PROFILE_NAMES[prof.kind]} — эскиз «${sk.name}»` }),
      el("p", { className: "hint", textContent: prof.kind === "axis" ? "Ось эскиза: используется для тел вращения и массивов по кругу (выберите её в разделе «Массив» тела)." : "Незамкнутые линии нельзя вытянуть. Замкните контур в эскизе инструментом «Линия»." }),
      buttonRow(["Изменить эскиз", () => startSketch(sk.plane, sk.hostBodyId, sk)], ["Удалить", () => deleteProfile(selProfile!)]),
    );
    return;
  }
  root.append(
    segmented(
      [["extrude", "Вытягивание"], ["revolve", "Вращение"]],
      ex.op ?? "extrude",
      (v) => {
        ex.op = v as "extrude" | "revolve";
        refresh();
      },
    ),
  );
  if (ex.op === "revolve") return renderRevolvePanel(root, sk, prof);
  root.append(
    el("h3", { textContent: `Вытягивание — ${PROFILE_NAMES[prof.kind].toLowerCase()}` }),
    el("p", { className: "hint", textContent: "Тяните стрелку или введите расстояние. Отрицательное — в другую сторону." }),
  );
  root.append(
    segmented(
      [["one", "В одну сторону"], ["sym", "Симметрично"]],
      ex.symmetric ? "sym" : "one",
      (v) => {
        ex.symmetric = v === "sym";
        renderProps();
        schedulePreview();
      },
    ),
  );
  const field = numberField(ex.symmetric ? "В каждую сторону, мм" : "Расстояние, мм", ex.distance, (v) => {
    ex.distance = v;
    view.setHandleDistance(v);
    schedulePreview();
  });
  distInput = field.querySelector("input");
  root.append(field);
  if (ex.symmetric) root.append(el("p", { className: "hint", textContent: `Всего ${fmt(Math.abs(ex.distance) * 2)} мм — поровну от плоскости эскиза.` }));

  const modeSel = el("select");
  for (const [v, t] of [["auto", "Авто"], ["new", "Новое тело"], ["add", "Добавить к телу"], ["cut", "Вырезать из тела"]] as const)
    modeSel.append(el("option", { value: v, textContent: t, selected: ex.mode === v }));
  modeSel.addEventListener("change", () => {
    ex.mode = modeSel.value as ExtrudeOpts["mode"];
    renderProps();
    schedulePreview();
  });
  root.append(el("div", { className: "field" }, el("label", { textContent: "Режим" }), modeSel));

  if ((ex.mode === "add" || ex.mode === "cut") && doc.bodies.length) {
    const cur = resolveOp(sk).target?.id;
    const tSel = el("select");
    for (const b of doc.bodies.filter((x) => !x.locked && !x.hidden)) tSel.append(el("option", { value: String(b.id), textContent: b.name, selected: b.id === cur }));
    tSel.addEventListener("change", () => {
      ex.targetId = Number(tSel.value);
      schedulePreview();
    });
    root.append(el("div", { className: "field" }, el("label", { textContent: "Тело" }), tSel));
  }

  opBox = el("div", { className: "op" });
  root.append(opBox);
  root.append(buttonRow(["Вытянуть", applyExtrude, "primary"]));
  if (prof.kind === "region")
    root.append(
      el("p", { className: "hint", textContent: `Выбрано областей: ${selProfile?.regions?.length ?? 1}. Касайтесь других областей эскиза, чтобы добавить или убрать их.` }),
      buttonRow(["Изменить эскиз", () => startSketch(sk.plane, sk.hostBodyId, sk)]),
    );
  else
    root.append(
      buttonRow(
        ["Изменить эскиз", () => startSketch(sk.plane, sk.hostBodyId, sk)],
        ["Удалить", () => deleteProfile(selProfile!)],
      ),
    );
}

function renderRevolvePanel(root: HTMLElement, sk: Sketch, prof: Profile) {
  const axes = sketchAxes(sk);
  root.append(el("h3", { textContent: `Вращение — ${PROFILE_NAMES[prof.kind].toLowerCase()}` }));
  if (!axes.length) {
    root.append(
      el("p", { className: "hint", textContent: "В эскизе нет оси. Откройте эскиз и проведите её инструментом «Ось» сбоку от профиля." }),
      buttonRow(["Изменить эскиз", () => startSketch(sk.plane, sk.hostBodyId, sk), "primary"]),
    );
    return;
  }
  if (axes.length > 1) {
    root.append(
      selectField(
        "Ось",
        axes.map((x, k) => [String(x.i), `Ось ${k + 1}`] as [string, string]),
        String(axes.find((x) => x.i === ex.axisIndex)?.i ?? axes[0].i),
        (v) => {
          ex.axisIndex = Number(v);
          schedulePreview();
        },
      ),
    );
  }
  root.append(
    numberField("Угол, °", ex.angle ?? 360, (v) => {
      if (!(v > 0 && v <= 360)) return toast("Угол — от 0 до 360°", true);
      ex.angle = v;
      schedulePreview();
    }),
  );
  const modeSel = selectField("Режим", [["auto", "Авто"], ["new", "Новое тело"], ["add", "Добавить к телу"], ["cut", "Вырезать из тела"]], ex.mode, (v) => {
    ex.mode = v as ExtrudeOpts["mode"];
    schedulePreview();
  });
  opBox = el("div", { className: "op" });
  root.append(modeSel, opBox, buttonRow(["Повернуть", applyExtrude, "primary"]), buttonRow(["Изменить эскиз", () => startSketch(sk.plane, sk.hostBodyId, sk)]));
}

function renderBodyPanel(root: HTMLElement, b: Body) {
  root.append(el("h3", { textContent: b.name }));

  if (b.prim) {
    const p = b.prim;
    const set = (patch: Partial<Primitive>) => (v: number) => {
      if (v <= 0) return toast("Размер должен быть больше нуля", true);
      updatePrimitive(b, { ...p, ...patch } as Primitive);
    };
    if (p.kind === "box") root.append(numberField("Ширина X", p.w, (v) => set({ w: v })(v)), numberField("Глубина Y", p.d, (v) => set({ d: v })(v)), numberField("Высота Z", p.h, (v) => set({ h: v })(v)));
    if (p.kind === "cylinder") root.append(numberField("Радиус", p.r, (v) => set({ r: v })(v)), numberField("Высота", p.h, (v) => set({ h: v })(v)));
    if (p.kind === "sphere") root.append(numberField("Радиус", p.r, (v) => set({ r: v })(v)));
  }

  const c = view.centerOf(b.id) ?? [0, 0, 0];
  root.append(el("h3", { textContent: "Положение центра, мм" }));
  (["X", "Y", "Z"] as const).forEach((axis, i) => {
    root.append(
      numberField(axis, c[i], (v) => {
        const d: Vec3 = [0, 0, 0];
        d[i] = v - c[i];
        moveBody(b.id, d);
      }),
    );
  });

  root.append(
    el("h3", { textContent: "Манипулятор" }),
    segmented(
      [["translate", "Перемещение"], ["scale", "Масштаб"]],
      gizmoMode,
      (v) => {
        gizmoMode = v as typeof gizmoMode;
        view.setGizmoMode(gizmoMode);
        renderProps();
      },
    ),
  );
  if (gizmoMode === "scale") {
    const rule = scaleRuleOf(b);
    root.append(
      el("p", { className: "hint", textContent: rule === "free" ? "Тяните кубики на осях — растяжение по оси, центральный — общий масштаб." : rule === "xy" ? "У цилиндра X и Y масштабируются вместе, высота — отдельно." : "Это тело масштабируется только равномерно." }),
      ...(["X", "Y", "Z"] as const).map((a, i) =>
        numberField(`Растяжение по ${a}, %`, 100, (v) => {
          if (!(v > 0)) return toast("Масштаб должен быть больше нуля", true);
          const f: Vec3 = [1, 1, 1];
          f[i] = v / 100;
          scaleBody(b.id, f);
        }),
      ),
      numberField("Общий масштаб, %", 100, (v) => (v > 0 ? scaleBody(b.id, [v / 100, v / 100, v / 100]) : toast("Масштаб должен быть больше нуля", true))),
    );
  }

  renderArraySection(root, b);

  root.append(el("h3", { textContent: "Рёбра (все)" }));
  const rField = numberField("Радиус / размер", 3, () => {});
  root.append(rField);
  const radius = () => parseFloat(rField.querySelector("input")!.value.replace(",", ".")) || 0;
  root.append(buttonRow(["Скруглить", () => edgeOp(b, "fillet", radius())], ["Фаска", () => edgeOp(b, "chamfer", radius())]));
}

function renderProps() {
  const root = $("#props");
  root.innerHTML = "";
  distInput = opBox = null;
  if (mode === "pickPlane") return renderPickPlane(root);
  if (mode === "sketch") return renderSketchPanel(root);
  const ctx = extrudeCtx();
  if (ctx) return renderExtrudePanel(root, ctx.sk, ctx.prof);
  if (mode === "plane") return renderPlaneTool(root);
  if (mode === "pickAxis") {
    root.append(
      el("h3", { textContent: "Ось массива" }),
      el("p", { className: "hint", textContent: "Коснитесь прямого ребра (массив вдоль него / вокруг него) или круглого ребра цилиндра (вокруг его оси). Касание пустого места — отмена." }),
      buttonRow(["Отмена", () => pickArrayAxis(null)]),
    );
    return;
  }
  if (sub) return renderSubPanel(root, sub);
  const rp = selPlane !== null ? doc.getPlane(selPlane) : undefined;
  if (rp) return renderPlanePanel(root, rp);
  const sel = selectedBodies();
  if (sel.length === 1 && sel[0].locked) return renderLockedPanel(root, sel[0]);
  if (sel.length === 1) return renderBodyPanel(root, sel[0]);
  if (sel.length > 1) return renderMultiPanel(root, sel);
  root.innerHTML = `<h3>Подсказки</h3><p class="hint">${PICK_HINTS[pickMode]}<br><br>«Эскиз» — нарисовать контур на плоскости или грани, затем вытянуть его.<br><br>Перо — выбор и рисование.<br>Один палец — вращать вид (вокруг точки под пальцем).<br>Два пальца — масштаб и сдвиг.<br>Касание двумя пальцами — отменить, тремя — повторить.</p>`;
}

function renderLockedPanel(root: HTMLElement, b: Body) {
  root.append(
    el("h3", { textContent: `${b.name} 🔒` }),
    el("p", { className: "hint", textContent: "Тело заблокировано: его нельзя выбрать в 3D-окне, переместить или изменить. Его грани можно использовать как плоскость эскиза." }),
    buttonRow(["Разблокировать", () => setBodyFlag([b.id], "locked", false), "primary"]),
  );
}

function renderMultiPanel(root: HTMLElement, sel: Body[]) {
  const ids = sel.map((b) => b.id);
  root.append(
    el("h3", { textContent: `Выбрано тел: ${sel.length}` }),
    el("p", { className: "hint", textContent: "Первое выбранное тело (синее) — основа для булевых операций, остальные (оранжевые) — инструменты." }),
    buttonRow(["∪ Объединить", () => boolean("union")], ["∖ Вычесть", () => boolean("subtract")]),
    buttonRow(["∩ Пересечь", () => boolean("intersect")], ["Копировать", () => copyBodies(ids)]),
    buttonRow(["Скрыть", () => setBodyFlag(ids, "hidden", true)], ["Заблокировать", () => setBodyFlag(ids, "locked", true)]),
    buttonRow(["Удалить", () => deleteBodies(ids)], ["Снять выбор", () => ((selection = []), refresh())]),
  );
}

const PICK_HINTS: Record<PickMode, string> = {
  auto: "Касание пером — грань, у самого ребра — ребро; двойное касание — тело целиком. Удержание пера на плоской грани — эскиз на ней.",
  vertex: "Касайтесь вершин тел.",
  body: "Касание — выбрать тело или профиль эскиза. «Рамка» — выбрать несколько тел.",
  face: "Касайтесь граней, чтобы выбрать их. Одна плоская грань — можно тянуть стрелкой (тяни-толкай).",
  edge: "Касайтесь рёбер, чтобы выбрать их для скругления или фаски. Повторное касание снимает выбор.",
};

function renderSubPanel(root: HTMLElement, s: NonNullable<typeof sub>) {
  if (s.edges.length) {
    root.append(
      el("h3", { textContent: `Рёбра: ${s.edges.length} — ${s.body.name}` }),
      el("p", { className: "hint", textContent: s.faces.length ? "Касайтесь других рёбер, чтобы добавить их в выбор." : "Тяните стрелку на ребре или введите размер. Касайтесь других рёбер, чтобы добавить их." }),
      segmented(
        [["fillet", "Скругление"], ["chamfer", "Фаска"]],
        edgeKind,
        (v) => {
          edgeKind = v as typeof edgeKind;
          renderProps();
          schedulePreview();
        },
      ),
    );
    const field = numberField(edgeKind === "fillet" ? "Радиус, мм" : "Размер фаски, мм", edgeSize, (v) => {
      if (!(v > 0)) return toast("Укажите размер больше нуля");
      edgeSize = v;
      view.setHandleDistance(v);
      schedulePreview();
    });
    distInput = field.querySelector("input");
    opBox = el("div", { className: "op" });
    root.append(field, opBox, buttonRow(["Применить", () => applyEdgeOp(), "primary"]));
  }
  if (!s.faces.length) return;
  const f = faceCtx();
  root.append(el("h3", { textContent: `Грани: ${s.faces.length} — ${s.body.name}` }));
  if (f) {
    root.append(el("p", { className: "hint", textContent: "Тяните стрелку: наружу — нарастить, внутрь — срезать." }));
    const field = numberField("Расстояние, мм", pp.distance, (v) => {
      pp.distance = v;
      view.setHandleDistance(v);
      schedulePreview();
    });
    distInput = field.querySelector("input");
    opBox = el("div", { className: "op" });
    root.append(
      field,
      opBox,
      buttonRow(["Применить", applyPushPull, "primary"]),
      buttonRow(["Эскиз на грани", () => startSketch(K.facePlane(f.body.shape, f.faceId)!, f.body.id)]),
    );
  } else if (s.faces.length === 1 && !s.edges.length) {
    root.append(el("p", { className: "hint", textContent: "Тяни-толкай доступен только для плоских граней." }));
  }
  root.append(
    el("h3", { textContent: "Оболочка" }),
    el("p", { className: "hint", textContent: "Сделать тело полым; выбранные грани станут открытыми." }),
    numberField("Толщина стенки, мм", shellThickness, (v) => (shellThickness = v)),
    buttonRow(["Сделать полым", applyShell]),
  );
}

/** Всплывающее меню действий у кнопки «⋯» */
function showMenu(anchor: HTMLElement, items: [string, () => void, string?][]) {
  document.querySelector(".menu")?.remove();
  const menu = el("div", { className: "menu" });
  for (const [text, fn, cls] of items) {
    const b = el("button", { textContent: text, className: cls ?? "" });
    b.addEventListener("click", () => {
      menu.remove();
      fn();
    });
    menu.append(b);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + h + 8 > innerHeight ? r.top - h - 6 : r.bottom + 6}px`;
  // Закрыть по касанию вне меню
  setTimeout(() => {
    const close = (e: Event) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener("pointerdown", close, true);
      }
    };
    document.addEventListener("pointerdown", close, true);
  });
}

function rowMenuButton(items: () => [string, () => void, string?][]) {
  const btn = el("button", { className: "row-menu", textContent: "⋯", title: "Действия" });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    showMenu(btn, items());
  });
  return btn;
}

function renderTree() {
  const ul = $("#body-list");
  ul.innerHTML = "";
  if (!doc.bodies.length) ul.append(el("li", { className: "empty", textContent: "Пусто — создайте тело или эскиз" }));
  for (const b of doc.bodies) {
    const order = selection.indexOf(b.id);
    const li = el(
      "li",
      { className: [order >= 0 ? "sel" : "", b.hidden ? "is-hidden" : "", b.locked ? "is-locked" : ""].join(" ") },
      el("span", { className: "swatch", style: `background:${b.color}` }),
      el("span", { className: "name", textContent: b.name }),
    );
    if (order >= 0 && selection.length > 1) li.append(el("span", { className: "order", textContent: order === 0 ? "основа" : "инстр." }));
    if (b.locked) li.append(el("span", { className: "flag", textContent: "🔒", title: "Заблокировано" }));
    if (b.hidden) li.append(el("span", { className: "flag", textContent: "◌", title: "Скрыто" }));
    li.append(
      rowMenuButton(() => [
        ["Переименовать", () => renameBody(b.id)],
        ["Копировать", () => copyBodies([b.id])],
        [b.hidden ? "Показать" : "Скрыть", () => setBodyFlag([b.id], "hidden", !b.hidden)],
        [b.locked ? "Разблокировать" : "Заблокировать", () => setBodyFlag([b.id], "locked", !b.locked)],
        ["Удалить", () => deleteBodies([b.id]), "danger"],
      ]),
    );
    li.addEventListener("click", () => {
      if (b.hidden) return toast("Тело скрыто — покажите его через «⋯»");
      select(b.id);
    });
    ul.append(li);
  }

  const pl = $("#plane-list");
  pl.innerHTML = "";
  $("#plane-head").style.display = doc.planes.length ? "" : "none";
  for (const rp of doc.planes) {
    const li = el(
      "li",
      { className: [selPlane === rp.id ? "sel" : "", rp.hidden ? "is-hidden" : ""].join(" ") },
      el("span", { className: "swatch plane-swatch" }),
      el("span", { className: "name", textContent: rp.name }),
    );
    if (rp.hidden) li.append(el("span", { className: "flag", textContent: "◌" }));
    li.append(
      rowMenuButton(() => [
        ["Эскиз на плоскости", () => startSketch(rp.plane)],
        [rp.hidden ? "Показать" : "Скрыть", () => doc.change({ planes: [{ ...rp, hidden: !rp.hidden }] })],
        ["Удалить", () => deletePlane(rp.id), "danger"],
      ]),
    );
    li.addEventListener("click", () => !rp.hidden && selectPlane(rp.id));
    pl.append(li);
  }

  const sl = $("#sketch-list");
  sl.innerHTML = "";
  $("#sketch-head").style.display = doc.sketches.length ? "" : "none";
  for (const sk of doc.sketches) {
    const li = el(
      "li",
      { className: selProfile?.sketchId === sk.id ? "sel" : "" },
      el("span", { className: "swatch", style: "border:2px solid #9fc0ff" }),
      el("span", { className: "name", textContent: `${sk.name} · ${sk.profiles.length}` }),
      rowMenuButton(() => [
        ["Переименовать", () => renameSketch(sk.id)],
        ["Изменить эскиз", () => startSketch(sk.plane, sk.hostBodyId, sk)],
        ["Удалить", () => doc.change({ removeSketches: [sk.id] }), "danger"],
      ]),
    );
    li.addEventListener("click", () => {
      // Сначала замкнутый профиль: оси и линии вытянуть нельзя
      const i = sk.profiles.findIndex(isClosed);
      selectProfile({ sketchId: sk.id, index: Math.max(0, i) });
    });
    sl.append(li);
  }
}

function refresh() {
  selection = selection.filter((id) => doc.get(id) && !doc.get(id)!.hidden);
  // Плоскость выбирается отдельно от тел, профилей и граней — новый выбор её снимает
  if (selPlane !== null && (!doc.getPlane(selPlane) || selection.length || selProfile || sub || mode !== "normal")) selPlane = null;
  if (selProfile && !profileRefValid(selProfile)) selProfile = null;
  // id граней/рёбер относятся к конкретной версии тела (после undo/операции — сброс)
  if (sub && doc.get(sub.bodyId) !== sub.body) sub = null;
  $("#app").classList.toggle("sketching", mode !== "normal");
  const toolPick = mode === "plane" ? planeToolPickMode() : mode === "pickAxis" ? "edge" : null;
  view.pickMode = toolPick ?? (mode === "pickPlane" ? "face" : pickMode);
  view.lockedPickable = mode === "pickPlane" || mode === "plane" || mode === "pickAxis";
  view.hoverBody = mode === "normal" && pickMode === "body";
  // Подсветка под курсором: плоские грани при выборе плоскости, иначе — по режиму выбора
  const hoverPick = toolPick ?? (mode === "pickPlane" ? "face" : mode === "normal" ? pickMode : "body");
  view.hoverMode = hoverPick === "face" || hoverPick === "edge" || hoverPick === "auto" ? hoverPick : null;
  view.hoverFilter = mode === "pickPlane" || (mode === "plane" && toolPick === "face") ? isPlanar : null;
  // Сначала ручка вытягивания: от неё зависит, к чему sync прикрепит манипулятор
  syncExtrude();
  const visible = doc.bodies.filter((b) => !b.hidden);
  const gizmoSel = mode === "normal" ? selection.filter((id) => !doc.get(id)?.locked) : [];
  view.sync(visible, gizmoSel, doc.sketches, selProfile, draft?.sketchId, doc.planes.filter((p) => !p.hidden), selPlane);
  view.setHighlight(mode === "normal" ? sub : null);
  for (const m of ["auto", "body", "face", "edge"] as const) $(`[data-cmd="pick-${m}"]`)?.classList.toggle("on", pickMode === m);
  renderTree();
  renderProps();
  renderCtxBar();
  updateToolbarState();
  $("#empty-state").style.display = mode === "normal" && !doc.bodies.length && !doc.sketches.length ? "" : "none";
  $<HTMLButtonElement>('[data-cmd="undo"]').disabled = mode === "pickPlane" || (mode === "normal" && !doc.canUndo());
  $<HTMLButtonElement>('[data-cmd="redo"]').disabled = mode !== "normal" || !doc.canRedo();
  if (mode === "pickPlane") status("Выберите плоскость эскиза");
}

doc.onChange(refresh);
doc.onChange(renderTimeline);

// ---------- шкала истории ----------
function setTimelineOpen(open: boolean) {
  $("#timeline").style.display = open ? "" : "none";
  $('[data-cmd="history"]').classList.toggle("on", open);
  setPref("timeline", open ? "1" : "0");
  renderTimeline();
}

/** Шаги истории; касание — вернуться к шагу (все шаги после него можно снова вернуть) */
function renderTimeline() {
  const box = $("#timeline");
  if (box.style.display === "none") return;
  const { steps, current } = doc.history();
  box.replaceChildren(
    ...steps.map((st, i) => {
      const b = el("button", { className: `step${i === current ? " cur" : ""}${st.undone ? " undone" : ""}`, title: st.label });
      b.append(el("span", { className: "n", textContent: String(i) }), el("span", { className: "t", textContent: st.label }));
      b.addEventListener("click", () => {
        if (mode !== "normal") return toast("Сначала завершите эскиз или инструмент");
        if (i === current) return;
        doc.goto(i);
        haptic("tick");
        toast(i < current ? `↶ К шагу ${i}` : `↷ К шагу ${i}`);
      });
      return b;
    }),
  );
  // Текущий шаг — в видимой части полосы
  (box.children[current] as HTMLElement | undefined)?.scrollIntoView({ inline: "center", block: "nearest" });
}

// Плоская ли грань — запрос к ядру дорогой, а подсветка зовёт его на каждое движение мыши
const planarCache = new WeakMap<K.Shape, Map<number, boolean>>();
function isPlanar(bodyId: number, faceId: number): boolean {
  const b = doc.get(bodyId);
  if (!b) return false;
  let m = planarCache.get(b.shape);
  if (!m) planarCache.set(b.shape, (m = new Map()));
  if (!m.has(faceId)) {
    let planar = false;
    try {
      planar = K.faceFrame(b.shape, faceId).planar;
    } catch {
      // грань без нормали (вырожденная) — не плоская
    }
    m.set(faceId, planar);
  }
  return m.get(faceId)!;
}

// ---------- панель инструментов: группы с выдвижным меню ----------
type Tool3 = [cmd: string, ico: string, label: string, need?: number];
const TOOL_GROUPS: { id: string; label: string; tools: Tool3[] }[] = [
  { id: "sketch", label: "Эскиз", tools: [["sketch", "✎", "Эскиз"], ["plane", "▱", "Плоскость"]] },
  { id: "bodies", label: "Тела", tools: [["cube", "▣", "Куб"], ["cylinder", "⬭", "Цилиндр"], ["sphere", "●", "Сфера"]] },
  { id: "bool", label: "Булевы", tools: [["union", "∪", "Объединить", 2], ["subtract", "∖", "Вычесть", 2], ["intersect", "∩", "Пересечь", 2]] },
  {
    id: "edit",
    label: "Правка",
    tools: [["multi", "⧉", "Мультивыбор"], ["box", "⬚", "Рамка"], ["select-all", "☰", "Все"], ["duplicate", "⎘", "Копия", 1], ["delete", "✕", "Удалить", 1]],
  },
  { id: "file", label: "Файл", tools: [["import", "⇧", "Импорт"], ["stl", "⇩", "STL"], ["step", "⇩", "STEP"], ["save-file", "⇩", "Проект"]] },
];
/** Касание после долгого нажатия на кнопку группы не должно запускать инструмент */
let suppressClick = false;

function toolButton([cmd, ico, label, need]: Tool3, group: string) {
  const b = el("button", { title: label }, el("span", { className: "ico", textContent: ico }), el("span", { className: "lbl", textContent: label }));
  b.dataset.cmd = cmd;
  b.dataset.group = group;
  if (need) b.dataset.need = String(need);
  return b;
}

function renderToolbar() {
  const box = $("#tool-groups");
  box.replaceChildren();
  for (const g of TOOL_GROUPS) {
    const face = g.tools.find((t) => t[0] === getPref(`tool:${g.id}`)) ?? g.tools[0];
    const btn = toolButton(face, g.id);
    btn.classList.add("group-face");
    // Кнопка группы не отключается — иначе недоступна и стрелка меню; команда сама подскажет, что выбрать
    delete btn.dataset.need;
    if (g.tools.length > 1) {
      // «›» в углу или долгое нажатие — все инструменты группы
      const more = el("span", { className: "more", textContent: "›", title: `Все: ${g.label}` });
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        openFlyout(g, btn);
      });
      btn.append(more);
      let timer = 0;
      btn.addEventListener("pointerdown", () => {
        timer = window.setTimeout(() => {
          suppressClick = true;
          haptic("tick");
          openFlyout(g, btn);
        }, 450);
      });
      for (const ev of ["pointerup", "pointerleave", "pointercancel"]) btn.addEventListener(ev, () => clearTimeout(timer));
    }
    box.append(el("div", { className: "group-label", textContent: g.label }), btn);
  }
  updateToolbarState();
}

function openFlyout(g: (typeof TOOL_GROUPS)[number], anchor: HTMLElement) {
  closeFlyout();
  const fly = el("div", { className: "flyout" }, ...g.tools.map((t) => toolButton(t, g.id)));
  document.body.append(fly);
  const r = anchor.getBoundingClientRect();
  const tb = $("#toolbar").getBoundingClientRect();
  const left = $("#app").classList.contains("left-hand");
  fly.style.top = `${Math.min(r.top, innerHeight - fly.offsetHeight - 8)}px`;
  fly.style.left = `${left ? tb.left - fly.offsetWidth - 10 : tb.right + 10}px`;
  updateToolbarState();
  setTimeout(() => {
    const close = (e: Event) => {
      if (!fly.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        closeFlyout();
        document.removeEventListener("pointerdown", close, true);
      }
    };
    document.addEventListener("pointerdown", close, true);
  });
}

function closeFlyout() {
  document.querySelector(".flyout")?.remove();
}

/** Включённые/недоступные кнопки — и на панели, и в открытом выдвижном меню */
function updateToolbarState() {
  document.querySelectorAll<HTMLButtonElement>("button[data-need]").forEach((btn) => {
    btn.disabled = selection.length < Number(btn.dataset.need);
  });
  document.querySelectorAll('[data-cmd="multi"]').forEach((b) => b.classList.toggle("on", multi));
  document.querySelectorAll('[data-cmd="box"]').forEach((b) => b.classList.toggle("on", view.boxSelect));
}

// ---------- долгое нажатие: эскиз на грани ----------
view.onLongPress = (pick) => {
  if (mode !== "normal" || !pick) return;
  if (pick.kind === "face") {
    const b = doc.get(pick.id);
    const pl = b && K.facePlane(b.shape, pick.faceId);
    if (!b || !pl) return toast("Эскиз можно начать только на плоской грани");
    haptic("confirm");
    return startSketch(pl, b.id);
  }
  if (pick.kind === "profile") {
    const sk = doc.getSketch(pick.sketchId)!;
    haptic("confirm");
    return startSketch(sk.plane, sk.hostBodyId, sk);
  }
  if (pick.kind === "plane") {
    haptic("confirm");
    return startSketch(doc.getPlane(pick.id)!.plane);
  }
};

// ---------- первые шаги ----------
const ONBOARD: { ico: string; title: string; text: string }[] = [
  { ico: "✎", title: "Перо рисует и выбирает", text: "Касание пером — грань, у самого ребра — ребро. Двойное касание — всё тело." },
  { ico: "✋", title: "Пальцы управляют видом", text: "Один палец — вращать вокруг точки под пальцем, два — сдвиг и масштаб. Ладонь на экране, пока работает перо, игнорируется." },
  { ico: "↶", title: "Жесты отмены", text: "Касание двумя пальцами — отменить, тремя — повторить." },
  { ico: "▭", title: "Эскиз и числа", text: "Удерживайте перо на плоской грани — начнётся эскиз на ней. Подписи у стрелок и размеров можно нажать и ввести число или выражение." },
];

function showOnboarding(step = 0) {
  document.querySelector("#onboard")?.remove();
  const c = ONBOARD[step];
  const last = step === ONBOARD.length - 1;
  const finish = () => {
    setPref("onboarded", "1");
    document.querySelector("#onboard")?.remove();
  };
  const skip = el("button", { textContent: "Пропустить" });
  skip.addEventListener("click", finish);
  const next = el("button", { className: "primary", textContent: last ? "Начать" : "Далее" });
  next.addEventListener("click", () => (last ? finish() : showOnboarding(step + 1)));
  const dots = el("div", { className: "dots" }, ...ONBOARD.map((_, i) => el("span", { className: i === step ? "on" : "" })));
  const card = el(
    "div",
    { className: "onboard-card" },
    el("div", { className: "big", textContent: c.ico }),
    el("h2", { textContent: c.title }),
    el("p", { textContent: c.text }),
    dots,
    el("div", { className: "row" }, skip, next),
  );
  document.body.append(el("div", { id: "onboard", className: "modal" }, card));
}

// ---------- контекстная панель у выделения ----------
type CtxItem = [ico: string, label: string, fn: (btn: HTMLElement) => void, on?: boolean];
const ctxBar = el("div", { className: "ctxbar" });
$("#viewport").append(ctxBar);
let ctxAnchor: Vec3 | null = null;

/** Действия для текущего выделения — рядом с ним, чтобы не тянуться к правой панели */
function ctxItems(): CtxItem[] {
  if (mode !== "normal") return [];
  const sel = selectedBodies();
  if (sub) {
    const bodyItem: CtxItem = ["⬚", "Тело", () => selectWholeBody(sub!.bodyId)];
    const e = edgeCtx();
    if (e)
      return [
        bodyItem,
        ["◜", "Скругл.", () => ((edgeKind = "fillet"), refresh()), edgeKind === "fillet"],
        ["◸", "Фаска", () => ((edgeKind = "chamfer"), refresh()), edgeKind === "chamfer"],
        ["✓", "Применить", () => applyEdgeOp()],
      ];
    const f = faceCtx();
    const items: CtxItem[] = [bodyItem];
    if (f) {
      items.push(["⇕", "Тянуть", () => distInput?.focus()]);
      items.push(["✎", "Эскиз", () => startSketch(K.facePlane(f.body.shape, f.faceId)!, f.body.id)]);
    }
    if (sub.faces.length) items.push(["◫", "Оболочка", () => applyShell()]);
    if (f) items.push(["✓", "Применить", () => applyPushPull()]);
    return items;
  }
  const ctx = extrudeCtx();
  if (ctx) {
    const { sk } = ctx;
    if (!isClosed(ctx.prof)) return [["✎", "Эскиз", () => startSketch(sk.plane, sk.hostBodyId, sk)]];
    return [
      ["⇧", "Вытянуть", () => ((ex.op = "extrude"), refresh()), (ex.op ?? "extrude") === "extrude"],
      ["⟳", "Вращать", () => ((ex.op = "revolve"), refresh()), ex.op === "revolve"],
      ["✓", "Применить", () => applyExtrude()],
      ["✎", "Эскиз", () => startSketch(sk.plane, sk.hostBodyId, sk)],
    ];
  }
  const rp = selPlane !== null ? doc.getPlane(selPlane) : undefined;
  if (rp)
    return [
      ["✎", "Эскиз", () => startSketch(rp.plane)],
      ["◌", "Скрыть", () => ((selPlane = null), doc.change({ planes: [{ ...rp, hidden: true }] }))],
      ["✕", "Удалить", () => deletePlane(rp.id)],
    ];
  if (sel.length > 1) {
    const ids = sel.map((b) => b.id);
    return [
      ["∪", "Объед.", () => boolean("union")],
      ["∖", "Вычесть", () => boolean("subtract")],
      ["∩", "Пересечь", () => boolean("intersect")],
      ["⎘", "Копия", () => copyBodies(ids)],
      ["✕", "Удалить", () => deleteBodies(ids)],
    ];
  }
  if (sel.length === 1) {
    const b = sel[0];
    if (b.locked) return [["🔓", "Разблок.", () => setBodyFlag([b.id], "locked", false)]];
    const setMode = (m: typeof gizmoMode) => () => {
      gizmoMode = m;
      view.setGizmoMode(m);
      refresh();
    };
    return [
      ["✥", "Двигать", setMode("translate"), gizmoMode === "translate"],
      ["⤡", "Масштаб", setMode("scale"), gizmoMode === "scale"],
      ["⎘", "Копия", () => copyBodies([b.id])],
      [
        "⋯",
        "Ещё",
        (btn) =>
          showMenu(btn, [
            ["Массив…", () => showPanelSection("Массив")],
            ["Переименовать", () => renameBody(b.id)],
            ["Скрыть", () => setBodyFlag([b.id], "hidden", true)],
            ["Заблокировать", () => setBodyFlag([b.id], "locked", true)],
            ["Удалить", () => deleteBodies([b.id]), "danger"],
          ]),
      ],
    ];
  }
  return [];
}

/** Точка в мире, у которой стоит панель: центр тела, грань, ребро, профиль или плоскость */
function ctxAnchorPoint(): Vec3 | null {
  if (mode !== "normal") return null;
  if (sub) return edgeCtx()?.frame.mid ?? faceCtx()?.frame.center ?? view.centerOf(sub.bodyId) ?? null;
  const ctx = extrudeCtx();
  if (ctx) return toWorld(ctx.sk.plane, centroid(ctx.prof));
  const rp = selPlane !== null ? doc.getPlane(selPlane) : undefined;
  if (rp) return rp.plane.origin;
  return selection.length ? (view.centerOf(selection[0]) ?? null) : null;
}

function renderCtxBar() {
  const items = ctxItems();
  ctxAnchor = items.length ? ctxAnchorPoint() : null;
  ctxBar.replaceChildren(
    ...items.map(([ico, label, fn, on]) => {
      const b = el("button", { className: on ? "on" : "", title: label }, el("span", { className: "ico", textContent: ico }), label);
      b.addEventListener("click", () => fn(b));
      return b;
    }),
  );
  ctxBar.style.display = ctxAnchor ? "" : "none";
  positionCtxBar();
}

/** Каждый кадр: панель следует за выделением при вращении вида, не выходя за края */
function positionCtxBar() {
  if (!ctxAnchor) return;
  const sp = view.screenOf(ctxAnchor);
  const host = $("#viewport");
  const w = ctxBar.offsetWidth;
  const h = ctxBar.offsetHeight;
  const x = Math.max(8, Math.min(sp.x - w / 2, host.clientWidth - w - 8));
  // Над объектом; если сверху места нет — под ним
  let y = sp.y - h - 90;
  if (y < 8) y = Math.min(sp.y + 90, host.clientHeight - h - 8);
  ctxBar.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
  ctxBar.style.visibility = sp.visible ? "" : "hidden";
}
view.onFrame = positionCtxBar;

/** Открыть правую панель и прокрутить к разделу */
function showPanelSection(title: string) {
  setPanelCollapsed(false);
  const h = [...document.querySelectorAll<HTMLElement>("#props h3")].find((x) => x.textContent === title);
  h?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- раскладка: левша, свёрнутая панель, полный экран ----------
function setPanelCollapsed(on: boolean) {
  $("#app").classList.toggle("panel-collapsed", on);
  $("[data-cmd=panel]").classList.toggle("on", !on);
  setPref("panel", on ? "0" : "1");
}

function setLeftHand(on: boolean) {
  $("#app").classList.toggle("left-hand", on);
  setPref("leftHand", on ? "1" : "0");
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => toast("Браузер не разрешил полный экран", true));
}

function showSettings(btn: HTMLElement) {
  const left = $("#app").classList.contains("left-hand");
  const items: [string, () => void][] = [
    [`Режим для левши: ${left ? "вкл" : "выкл"}`, () => setLeftHand(!left)],
    [$("#app").classList.contains("panel-collapsed") ? "Показать панель свойств" : "Скрыть панель свойств", () => setPanelCollapsed(!$("#app").classList.contains("panel-collapsed"))],
  ];
  // В APK полноэкранный режим включён всегда (системные панели скрыты в MainActivity)
  if (!Capacitor.isNativePlatform()) items.push([document.fullscreenElement ? "Выйти из полного экрана" : "Полный экран", toggleFullscreen]);
  items.push(["Подсказки: перо, жесты, эскиз", () => showOnboarding(0)]);
  showMenu(btn, items);
}

// ---------- настройки вида: тема, привязка, проекция ----------
function getPref(key: string): string | null {
  try {
    return localStorage.getItem(`tabcad:${key}`);
  } catch {
    return null;
  }
}

function setPref(key: string, value: string) {
  try {
    localStorage.setItem(`tabcad:${key}`, value);
  } catch {
    // localStorage недоступен — настройка просто не запомнится
  }
}

type Theme = "dark" | "light";
function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  view.setTheme(t);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#1e2229" : "#e4e9ef");
  $("[data-cmd=theme]").textContent = t === "dark" ? "☾" : "☀";
  setPref("theme", t);
  refresh();
  drawDraft();
}

function applySnap(on: boolean) {
  view.setGridSnap(on);
  $("[data-cmd=snap]").classList.toggle("on", on);
  setPref("snap", on ? "1" : "0");
}

view.onProjectionChange = (p) => setPref("projection", p);

const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
applyTheme((getPref("theme") as Theme | null) ?? (prefersDark ? "dark" : "light"));
setLeftHand(getPref("leftHand") === "1");
setPanelCollapsed(getPref("panel") === "0");
installNumpad();
renderToolbar();
applySnap(getPref("snap") !== "0");
if (getPref("projection") === "ortho") view.setProjection("ortho");
if (getPref("timeline") === "1") setTimelineOpen(true);

// ---------- проекты ----------
const LAST_KEY = "tabcad:lastProject";
let projectId = "";
let projectName = "";
let dirty = false;
/** Идёт загрузка проекта — изменение документа не считается правкой */
let loading = false;
let saveTimer = 0;
let saving: Promise<void> = Promise.resolve();

function remember(id: string) {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    // localStorage может быть недоступен (приватный режим) — не критично
  }
}

function recall() {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

function setSaveState(text: string) {
  $("#save-state").textContent = text;
}

/** Автосохранение: через секунду после последнего изменения */
function scheduleSave() {
  if (loading || !projectId) return;
  dirty = true;
  setSaveState("Не сохранено");
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 1000);
}

function saveNow(): Promise<void> {
  clearTimeout(saveTimer);
  if (!dirty || !projectId) return saving;
  dirty = false;
  let data: string;
  try {
    data = serialize(doc, projectName);
  } catch (err) {
    console.error(err);
    setSaveState("Ошибка сохранения");
    return saving;
  }
  const meta = { id: projectId, name: projectName, updated: Date.now(), thumb: view.thumbnail() };
  setSaveState("Сохранение…");
  saving = saving
    .then(() => S.saveProject(meta, data))
    .then(
      () => setSaveState(dirty ? "Не сохранено" : "Сохранено"),
      (err) => {
        console.error(err);
        dirty = true;
        setSaveState("Ошибка сохранения");
        toast("Не удалось сохранить проект", true);
      },
    );
  return saving;
}

doc.onChange(scheduleSave);
// Планшет может выгрузить вкладку в фоне — сохраняем при сворачивании
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && saveNow());
window.addEventListener("pagehide", () => saveNow());

/** Содержимое проекта без имени */
type Content = { bodies: Body[]; sketches: Sketch[]; nextId: number; planes?: RefPlane[] };

function applyLoaded(id: string, name: string, p: Content) {
  if (mode !== "normal") exitSketchMode();
  selection = [];
  selProfile = null;
  sub = null;
  projectId = id;
  projectName = name;
  remember(id);
  loading = true;
  if (mode === "plane") exitPlaneTool();
  selPlane = null;
  doc.load(p.bodies, p.sketches, p.nextId, p.planes ?? []);
  loading = false;
  $("#project-name").textContent = name;
  setSaveState("Сохранено");
  view.fit();
  closeProjects();
}

async function openProject(id: string): Promise<boolean> {
  await saveNow();
  const [meta, data] = await Promise.all([S.getMeta(id), S.loadData(id)]);
  if (!meta || data === undefined) {
    toast("Проект не найден", true);
    return false;
  }
  try {
    applyLoaded(id, meta.name, deserialize(data));
    return true;
  } catch (err) {
    console.error(err);
    toast(`Не удалось открыть «${meta.name}»: ${(err as Error).message}`, true);
    return false;
  }
}

async function newProject(name?: string, content: Content = { bodies: [], sketches: [], nextId: 1 }) {
  await saveNow();
  const n = (await S.listProjects()).length;
  applyLoaded(S.newProjectId(), name ?? `Проект ${n + 1}`, content);
  dirty = true;
  await saveNow();
}

async function renameProject() {
  const v = await uiPrompt("Название проекта", projectName);
  if (!v || v === projectName) return;
  projectName = v;
  $("#project-name").textContent = v;
  dirty = true;
  saveNow();
}

const fileSafe = (name: string) => name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "project";

async function saveFile() {
  await saveNow();
  download(new Blob([serialize(doc, projectName)], { type: "application/json" }), `${fileSafe(projectName)}.remeslo`);
}

async function showProjects() {
  await saveNow();
  let list: S.ProjectMeta[];
  try {
    list = await S.listProjects();
  } catch (err) {
    console.error(err);
    return toast("Хранилище проектов недоступно", true);
  }
  const grid = $("#project-grid");
  grid.innerHTML = "";

  const add = el("div", { className: "card new" }, el("div", { className: "thumb", textContent: "+" }), el("div", { className: "info" }, el("div", { className: "name", textContent: "Новый проект" })));
  add.addEventListener("click", () => newProject());
  grid.append(add);

  for (const p of list) {
    const thumb = el("div", { className: "thumb" });
    if (p.thumb) thumb.style.backgroundImage = `url("${p.thumb}")`;
    else thumb.textContent = "▣";
    const actions = el("div", { className: "actions" });
    const action = (text: string, fn: () => void) => {
      const b = el("button", { textContent: text });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      actions.append(b);
    };
    action("Имя", () => renameStored(p));
    action("Копия", () => duplicateProject(p));
    action("Файл", () => downloadProject(p));
    action("Удалить", () => removeProject(p));
    const date = new Date(p.updated).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
    const card = el(
      "div",
      { className: "card" + (p.id === projectId ? " current" : "") },
      thumb,
      el("div", { className: "info" }, el("div", { className: "name", textContent: p.name }), el("div", { className: "date", textContent: date })),
      actions,
    );
    card.addEventListener("click", () => (p.id === projectId ? closeProjects() : openProject(p.id)));
    grid.append(card);
  }
  $("#projects").classList.remove("hidden");
}

function closeProjects() {
  $("#projects").classList.add("hidden");
}

async function renameStored(p: S.ProjectMeta) {
  if (p.id === projectId) {
    await renameProject();
    return showProjects();
  }
  const v = await uiPrompt("Название проекта", p.name);
  if (!v) return;
  await S.saveProject({ ...p, name: v });
  showProjects();
}

async function duplicateProject(p: S.ProjectMeta) {
  await saveNow();
  const data = await S.loadData(p.id);
  if (data === undefined) return toast("Проект не найден", true);
  await S.saveProject({ id: S.newProjectId(), name: `${p.name} (копия)`, updated: Date.now(), thumb: p.thumb }, data);
  showProjects();
}

async function downloadProject(p: S.ProjectMeta) {
  await saveNow();
  const data = await S.loadData(p.id);
  if (data !== undefined) download(new Blob([data], { type: "application/json" }), `${fileSafe(p.name)}.remeslo`);
}

async function removeProject(p: S.ProjectMeta) {
  if (!(await uiConfirm(`Удалить проект «${p.name}»? Это действие нельзя отменить.`, "Удалить", true))) return;
  await S.deleteProject(p.id);
  if (p.id === projectId) {
    // Текущий проект удалён — не даём автосохранению вернуть его
    projectId = "";
    dirty = false;
    const next = (await S.listProjects())[0];
    if (!next || !(await openProject(next.id))) await newProject();
  }
  showProjects();
}

// Открыть .remeslo (или старый .tabcad) как новый проект; STEP/STL — добавить тела в текущий
const fileInput = $<HTMLInputElement>("#file-input");
// Android не знает MIME-тип .remeslo и скрыл бы такие файлы в выборе — показываем все
if (Capacitor.isNativePlatform()) fileInput.accept = "";
function pickFile() {
  fileInput.value = "";
  fileInput.click();
}

fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  const ext = f.name.split(".").pop()!.toLowerCase();
  const base = f.name.replace(/\.[^.]+$/, "");
  if (ext === "remeslo" || ext === "tabcad" || ext === "json") {
    try {
      const p = deserialize(await f.text());
      await newProject(p.name || base, p);
      toast("Проект открыт");
    } catch (err) {
      console.error(err);
      toast(`Не удалось открыть файл: ${(err as Error).message}`, true);
    }
    return;
  }
  closeProjects();
  status("Импорт…");
  try {
    const shapes = await K.importFile(f);
    const bodies = shapes.map((shape, i) => {
      const b = doc.newBody({ shape, offset: [0, 0, 0] });
      b.name = shapes.length > 1 ? `${base} ${i + 1}` : base;
      return b;
    });
    if (mode !== "normal") exitSketchMode();
    selection = bodies.map((b) => b.id);
    selProfile = null;
    sub = null;
    doc.replace(bodies);
    view.fit();
    toast(`Импортировано тел: ${bodies.length}`);
  } catch (err) {
    console.error(err);
    toast("Не удалось импортировать файл", true);
  } finally {
    status("");
  }
});

// ---------- запуск ----------
(async () => {
  refresh();
  const t0 = performance.now();
  try {
    await K.initKernel();
  } catch (err) {
    console.error(err);
    $("#loader").innerHTML = "<div>Не удалось загрузить CAD-ядро. Обновите страницу.</div>";
    return;
  }
  $("#loader").classList.add("hidden");
  status(`Ядро OpenCascade готово за ${((performance.now() - t0) / 1000).toFixed(1)} с`);
  if (getPref("onboarded") !== "1") showOnboarding(0);
  (window as any).__tabcad = { doc, view, K };

  S.requestPersistence();
  try {
    const list = await S.listProjects();
    const last = list.find((p) => p.id === recall()) ?? list[0];
    if (!last || !(await openProject(last.id))) await newProject();
  } catch (err) {
    console.error(err);
    toast("Хранилище недоступно — проект не будет сохраняться", true);
  }
})();
