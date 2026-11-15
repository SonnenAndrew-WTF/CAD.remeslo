// Документ: тела, эскизы и вспомогательные плоскости + история изменений (undo/redo).
// Объекты неизменяемы: любое изменение создаёт новый объект,
// поэтому снимок истории — это просто набор ссылок.
import type { Primitive, Shape, Vec3, SketchPlane, Profile } from "./kernel";
import type { RefDim } from "./sketch";
import type { Constraint } from "./constraints";

export interface Body {
  id: number;
  name: string;
  color: string;
  shape: Shape;
  /** Параметры примитива — есть, пока тело не прошло булеву операцию/скругление */
  prim?: Primitive;
  offset: Vec3;
  /** Скрыто: не рисуется, не выбирается, не экспортируется */
  hidden?: boolean;
  /** Заблокировано: видно, но защищено от выбора и изменений */
  locked?: boolean;
}

export interface Sketch {
  id: number;
  name: string;
  plane: SketchPlane;
  profiles: Profile[];
  /** Тело, на грани которого нарисован эскиз — цель по умолчанию для вытягивания */
  hostBodyId?: number;
  /** Размеры от точек эскиза до рёбер тела/осей */
  refDims?: RefDim[];
  /** Геометрические связи между элементами эскиза */
  constraints?: Constraint[];
}

/** Дополнительная (вспомогательная) плоскость для эскизов */
export interface RefPlane {
  id: number;
  name: string;
  plane: SketchPlane;
  hidden?: boolean;
}

interface State {
  bodies: Body[];
  sketches: Sketch[];
  planes: RefPlane[];
  /** Что привело к этому состоянию — подпись на шкале истории */
  label: string;
}

/** Шаг на шкале истории */
export interface HistoryStep {
  label: string;
  /** Отменённый шаг — его можно вернуть, пока не сделано новое действие */
  undone: boolean;
}

/** Подпись шага по разнице состояний: что добавилось, удалилось или изменилось */
function describe(prev: State, next: State, action?: string): string {
  const diff = <T extends { id: number; name: string }>(a: T[], b: T[]) => ({
    added: b.filter((x) => !a.some((y) => y.id === x.id)),
    removed: a.filter((x) => !b.some((y) => y.id === x.id)),
    changed: b.filter((x) => a.some((y) => y.id === x.id && y !== x)),
  });
  const parts: { added: { name: string }[]; removed: { name: string }[]; changed: { name: string }[] }[] = [
    diff(prev.bodies, next.bodies),
    diff(prev.sketches, next.sketches),
    diff(prev.planes, next.planes),
  ];
  const names = (list: { name: string }[]) => list.map((x) => `«${x.name}»`).join(", ");
  const added = parts.flatMap((d) => d.added);
  const removed = parts.flatMap((d) => d.removed);
  const changed = parts.flatMap((d) => d.changed);
  const what = [added.length ? `+ ${names(added)}` : "", changed.length ? names(changed) : "", removed.length ? `− ${names(removed)}` : ""].filter(Boolean).join(" ");
  if (action) return what ? `${action}: ${what}` : action;
  return what || "Изменение";
}

const PALETTE = ["#7aa2ff", "#ffb02e", "#5dd39e", "#ff7a90", "#b48cff", "#4fd1e8", "#e8d24f"];
const HISTORY_LIMIT = 60;

/** Заменить элементы с теми же id, удалить removeIds, новые добавить в конец */
function merge<T extends { id: number }>(list: T[], updates: T[], removeIds: number[]): T[] {
  const map = new Map(updates.map((x) => [x.id, x]));
  const next = list.filter((x) => !removeIds.includes(x.id)).map((x) => map.get(x.id) ?? x);
  for (const u of updates) if (!next.includes(u)) next.push(u);
  return next;
}

export class Doc {
  private state: State = { bodies: [], sketches: [], planes: [], label: "Начало" };
  /** Название текущего действия (задаёт интерфейс перед изменением) — для подписи в истории */
  action: string | undefined;
  private past: State[] = [];
  private future: State[] = [];
  private nextId = 1;
  private listeners: (() => void)[] = [];

  get bodies() {
    return this.state.bodies;
  }
  get sketches() {
    return this.state.sketches;
  }
  get planes() {
    return this.state.planes;
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  newId() {
    return this.nextId++;
  }

  /** Следующий свободный id — сохраняется вместе с проектом */
  get idCounter() {
    return this.nextId;
  }

  /** Заменить содержимое целиком (открытие проекта): история отмены начинается заново */
  load(bodies: Body[], sketches: Sketch[], nextId: number, planes: RefPlane[] = []) {
    this.state = { bodies, sketches, planes, label: "Начало" };
    this.past = [];
    this.future = [];
    const ids = [...bodies, ...sketches, ...planes].map((x) => x.id + 1);
    this.nextId = Math.max(nextId, ...ids, 1);
    this.emit();
  }

  newBody(fields: Omit<Body, "id" | "color" | "name"> & { name?: string; color?: string }): Body {
    const id = this.newId();
    return {
      id,
      name: fields.name ?? `Тело ${id}`,
      color: fields.color ?? PALETTE[(id - 1) % PALETTE.length],
      ...fields,
    } as Body;
  }

  get(id: number) {
    return this.state.bodies.find((b) => b.id === id);
  }

  getSketch(id: number) {
    return this.state.sketches.find((s) => s.id === id);
  }

  getPlane(id: number) {
    return this.state.planes.find((p) => p.id === id);
  }

  private commit(next: State) {
    next.label = describe(this.state, next, this.action);
    this.past.push(this.state);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this.state = next;
    this.emit();
  }

  /** Одно действие пользователя = один шаг истории, даже если меняет и тела, и эскизы */
  change(opts: {
    bodies?: Body[];
    removeBodies?: number[];
    sketches?: Sketch[];
    removeSketches?: number[];
    planes?: RefPlane[];
    removePlanes?: number[];
  }) {
    this.commit({
      bodies: merge(this.state.bodies, opts.bodies ?? [], opts.removeBodies ?? []),
      sketches: merge(this.state.sketches, opts.sketches ?? [], opts.removeSketches ?? []),
      planes: merge(this.state.planes, opts.planes ?? [], opts.removePlanes ?? []),
      label: "",
    });
  }

  replace(updates: Body[], removeIds: number[] = []) {
    this.change({ bodies: updates, removeBodies: removeIds });
  }

  canUndo() {
    return this.past.length > 0;
  }
  canRedo() {
    return this.future.length > 0;
  }

  undo() {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.state);
    this.state = prev;
    this.emit();
  }

  redo() {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.state);
    this.state = next;
    this.emit();
  }

  /** Шкала истории: прошлые шаги, текущий (index = past.length) и отменённые */
  history(): { steps: HistoryStep[]; current: number } {
    const steps = [
      ...this.past.map((s) => ({ label: s.label, undone: false })),
      { label: this.state.label, undone: false },
      ...[...this.future].reverse().map((s) => ({ label: s.label, undone: true })),
    ];
    return { steps, current: this.past.length };
  }

  /** Перейти к шагу истории (несколько отмен/повторов за раз) */
  goto(index: number) {
    let moved = false;
    while (this.past.length > index && this.past.length) {
      this.future.push(this.state);
      this.state = this.past.pop()!;
      moved = true;
    }
    while (this.past.length < index && this.future.length) {
      this.past.push(this.state);
      this.state = this.future.pop()!;
      moved = true;
    }
    if (moved) this.emit();
  }
}
