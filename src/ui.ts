// Элементы интерфейса для планшета: цифровая клавиатура с выражениями,
// свои диалоги вместо системных prompt/confirm, вибрация.
import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";

// ---------- выражения ----------

/**
 * Значение поля: число или выражение — «40+5», «100/3», «2*(10+5)», «4см».
 * Единицы: мм (по умолчанию), см (×10), м (×1000), ° (без изменения). Без eval.
 */
export function evalExpr(src: string): number | null {
  const s = src
    .replace(/,/g, ".")
    .replace(/[×xх*]/g, "*")
    .replace(/[÷:]/g, "/")
    .replace(/[−–]/g, "-")
    .replace(/\s+/g, "")
    .replace(/см/g, "*10")
    .replace(/мм/g, "")
    .replace(/(\d|\))м/g, "$1*1000")
    .replace(/°/g, "");
  if (!s) return null;
  let i = 0;
  const peek = () => s[i];
  const num = (): number => {
    if (peek() === "(") {
      i++;
      const v = sum();
      if (s[i++] !== ")") throw new Error("скобка");
      return v;
    }
    if (peek() === "-") {
      i++;
      return -num();
    }
    if (peek() === "+") {
      i++;
      return num();
    }
    const m = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(s.slice(i));
    if (!m) throw new Error("число");
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const prod = (): number => {
    let v = num();
    while (peek() === "*" || peek() === "/") v = s[i++] === "*" ? v * num() : v / num();
    return v;
  };
  const sum = (): number => {
    let v = prod();
    while (peek() === "+" || peek() === "-") v = s[i++] === "+" ? v + prod() : v - prod();
    return v;
  };
  try {
    const v = sum();
    return i === s.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

const fmt = (v: number) => String(+v.toFixed(4));

// ---------- цифровая клавиатура ----------

/** Последний тип указателя: на пальце/пере показываем свою клавиатуру вместо системной */
let touchLike = false;
export const isTouchLike = () => touchLike;

const KEYS: (string | [string, string])[] = [
  "7", "8", "9", ["⌫", "back"],
  "4", "5", "6", ["÷", "÷"],
  "1", "2", "3", ["×", "×"],
  "0", ".", ["±", "neg"], ["−", "−"],
  "(", ")", ["см", "см"], ["+", "+"],
];

let pad: HTMLDivElement | null = null;
let target: HTMLInputElement | null = null;
let original = "";
/** Значение ещё не трогали: первая цифра заменяет его целиком (как выделенный текст) */
let fresh = false;
/** Куда пользователь перетащил клавиатуру — в следующий раз она откроется там же */
let padPos: { left: number; top: number } | null = null;
const OPERATORS = ["+", "−", "×", "÷"];

function closePad() {
  pad?.remove();
  pad = null;
  target = null;
}

function preview() {
  if (!pad || !target) return;
  const v = evalExpr(target.value);
  const line = pad.querySelector(".np-preview")!;
  const isExpr = /[+\-*/×÷−()смм]/.test(target.value.replace(/^-/, ""));
  line.textContent = v === null ? (target.value ? "…" : " ") : isExpr ? `= ${fmt(v)}` : " ";
}

function press(key: string) {
  const t = target;
  if (!t) return;
  // Первое нажатие цифры заменяет старое значение; оператор продолжает его (40 → 40+5)
  if (fresh && key !== "ok" && key !== "cancel" && key !== "neg" && key !== "back" && !OPERATORS.includes(key)) t.value = "";
  if (key !== "ok" && key !== "cancel") fresh = false;
  if (key === "back") t.value = t.value.slice(0, -1);
  else if (key === "neg") t.value = t.value.startsWith("-") ? t.value.slice(1) : "-" + t.value;
  else if (key === "clear") t.value = "";
  else if (key === "ok") {
    const v = evalExpr(t.value);
    if (v === null) {
      pad?.classList.remove("shake");
      void pad?.offsetWidth;
      pad?.classList.add("shake");
      return;
    }
    t.value = fmt(v);
    // Поля приложения коммитят по change, поле размера эскиза — по Enter
    t.dispatchEvent(new Event("change", { bubbles: true }));
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    closePad();
    t.blur();
    return;
  } else if (key === "cancel") {
    t.value = original;
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    closePad();
    t.blur();
    return;
  } else t.value += key;
  haptic("tick");
  preview();
}

function openPad(input: HTMLInputElement) {
  closePad();
  target = input;
  original = input.value;
  fresh = true;
  pad = document.createElement("div");
  pad.className = "numpad";
  pad.innerHTML = `<div class="np-grip" title="Перетащите клавиатуру"></div><div class="np-preview"> </div>`;
  const grid = document.createElement("div");
  grid.className = "np-grid";
  const all: [string, string, string?][] = [
    ...KEYS.map((k) => (typeof k === "string" ? ([k, k] as [string, string]) : k)),
    ["C", "clear"],
    ["Отмена", "cancel", "wide"],
    ["✓", "ok", "ok"],
  ];
  for (const [label, key, cls] of all) {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    // pointerdown + preventDefault: поле не теряет фокус при нажатии клавиши
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      // Нажатие видно: клавиша «утапливается» (preventDefault гасит :active на части устройств)
      b.classList.remove("pressed");
      void b.offsetWidth;
      b.classList.add("pressed");
      setTimeout(() => b.classList.remove("pressed"), 160);
      press(key);
    });
    grid.append(b);
  }
  pad.append(grid);
  document.body.append(pad);
  // Ставим под полем, а если не помещается — над ним; по горизонтали — в пределах экрана
  const r = input.getBoundingClientRect();
  const w = pad.offsetWidth;
  const h = pad.offsetHeight;
  const clampX = (x: number) => Math.max(8, Math.min(x, innerWidth - w - 8));
  const clampY = (y: number) => Math.max(8, Math.min(y, innerHeight - h - 8));
  if (padPos) {
    pad.style.left = `${clampX(padPos.left)}px`;
    pad.style.top = `${clampY(padPos.top)}px`;
  } else {
    pad.style.left = `${clampX(r.right - w)}px`;
    pad.style.top = `${r.bottom + h + 8 < innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
  }
  // Перетаскивание за полоску сверху или за строку результата — если клавиатура закрывает размер
  const box = pad;
  const drag = (e: PointerEvent) => {
    e.preventDefault(); // поле не теряет фокус
    const sx = e.clientX - box.offsetLeft;
    const sy = e.clientY - box.offsetTop;
    const move = (m: PointerEvent) => {
      padPos = { left: clampX(m.clientX - sx), top: clampY(m.clientY - sy) };
      box.style.left = `${padPos.left}px`;
      box.style.top = `${padPos.top}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  pad.querySelector<HTMLElement>(".np-grip")!.addEventListener("pointerdown", drag);
  pad.querySelector<HTMLElement>(".np-preview")!.addEventListener("pointerdown", drag);
  input.select();
  preview();
}

/**
 * Числовые поля (data-num): на пальце/пере вместо системной клавиатуры, закрывающей
 * полэкрана, открывается своя — с выражениями и единицами. Мышь и клавиатура работают как обычно.
 */
export function installNumpad() {
  window.addEventListener(
    "pointerdown",
    (e) => {
      touchLike = e.pointerType === "touch" || e.pointerType === "pen";
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement && t.dataset.num !== undefined) t.inputMode = touchLike ? "none" : "decimal";
    },
    true,
  );
  document.addEventListener("focusin", (e) => {
    const t = e.target as HTMLElement;
    if (touchLike && t instanceof HTMLInputElement && t.dataset.num !== undefined) openPad(t);
  });
  document.addEventListener("focusout", (e) => {
    if (e.target === target) closePad();
  });
  document.addEventListener("input", (e) => e.target === target && preview());
}

// ---------- диалоги ----------

function modal(build: (box: HTMLDivElement, close: () => void) => void) {
  const overlay = document.createElement("div");
  overlay.className = "modal";
  const box = document.createElement("div");
  box.className = "modal-box";
  overlay.append(box);
  const close = () => overlay.remove();
  build(box, close);
  document.body.append(overlay);
  return overlay;
}

/** Ввод строки (переименование); null — отмена */
export function uiPrompt(title: string, value: string, okLabel = "Сохранить"): Promise<string | null> {
  return new Promise((resolve) => {
    modal((box, close) => {
      const h = document.createElement("h3");
      h.textContent = title;
      const input = document.createElement("input");
      input.value = value;
      const row = document.createElement("div");
      row.className = "row";
      const cancel = document.createElement("button");
      cancel.textContent = "Отмена";
      const ok = document.createElement("button");
      ok.textContent = okLabel;
      ok.className = "primary";
      const done = (v: string | null) => {
        close();
        resolve(v);
      };
      cancel.addEventListener("click", () => done(null));
      ok.addEventListener("click", () => done(input.value.trim() || null));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done(input.value.trim() || null);
        if (e.key === "Escape") done(null);
      });
      row.append(cancel, ok);
      box.append(h, input, row);
      setTimeout(() => {
        input.focus();
        input.select();
      });
    });
  });
}

/** Подтверждение; danger — красная кнопка для необратимых действий */
export function uiConfirm(message: string, okLabel: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    modal((box, close) => {
      const p = document.createElement("p");
      p.textContent = message;
      const row = document.createElement("div");
      row.className = "row";
      const cancel = document.createElement("button");
      cancel.textContent = "Отмена";
      const ok = document.createElement("button");
      ok.textContent = okLabel;
      ok.className = danger ? "primary danger" : "primary";
      const done = (v: boolean) => {
        close();
        resolve(v);
      };
      cancel.addEventListener("click", () => done(false));
      ok.addEventListener("click", () => done(true));
      row.append(cancel, ok);
      box.append(p, row);
    });
  });
}

// ---------- вибрация ----------

let lastHaptic = 0;
/** Короткий отклик: tick — привязка/клавиша, confirm — действие выполнено */
export function haptic(kind: "tick" | "confirm" = "tick") {
  const now = performance.now();
  if (now - lastHaptic < 40) return;
  lastHaptic = now;
  if (Capacitor.isNativePlatform()) Haptics.impact({ style: kind === "tick" ? ImpactStyle.Light : ImpactStyle.Medium }).catch(() => {});
  // Браузер разрешает вибрацию только после касания пользователем
  else if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(kind === "tick" ? 6 : 15);
}
