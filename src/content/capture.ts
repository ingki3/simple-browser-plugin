import type { CaptureMetrics, CaptureScrolled } from "@/lib/pageCapture";

// 페이지 전체 캡처(capture_page, #49)의 문서 쪽 단계. 백그라운드가 화면을 찍고, 여기서는 스크롤·잠시 바꾼 스타일과
// 그 복원만 맡는다. 판정은 계산 스타일(position·overflow)과 크기로만 한다.
// - sticky 요소는 처음부터 relative로 둔다(배치가 같고, 자기 자리에 한 번만 찍힌다).
// - fixed 요소는 첫 화면에는 그대로 찍히고, 그 뒤 화면에서는 투명하게 숨긴다(매 장마다 반복되지 않게).
// - 끝나면(오류·중단 포함) 원래 스크롤 위치와 inline 스타일로 되돌린다. 백그라운드가 사라져 end가 오지 않아도
//   마지막 단계 뒤 일정 시간이 지나면 스스로 되돌린다.

const IDLE_RESTORE_MS = 15_000;
// 스크롤한 뒤 화면 안 이미지가 뜨기를 기다리는 최대 시간(지연 로딩).
const LAZY_WAIT_MS = 1_500;
const SETTLE_MS = 150;
const MAX_SCAN = 50_000;

interface SavedProp {
  el: HTMLElement;
  prop: string;
  value: string;
  priority: string;
}

// 요소의 원래 style 속성 글자와 그때의 해석 결과. 되돌린 뒤 해석 결과가 같으면 속성 글자까지 그대로 되돌린다
// (속성별로만 되돌리면 브라우저가 글자를 다시 써 "a:b" → "a: b;"처럼 바뀐다). 그 사이 페이지가 같은 요소의 다른
// inline 스타일을 바꿨으면 그 변경은 두고 바꾼 속성만 되돌린다.
interface SavedAttr {
  attr: string | null;
  cssText: string;
}

interface Session {
  token: string;
  scrollX: number;
  scrollY: number;
  saved: SavedProp[];
  attrs: Map<HTMLElement, SavedAttr>;
  // 이미 바꾼 요소·속성(같은 속성을 두 번 저장하지 않게).
  touched: WeakMap<HTMLElement, Set<string>>;
  timer: ReturnType<typeof setTimeout> | null;
}

let session: Session | null = null;

function setImportant(s: Session, el: HTMLElement, prop: string, value: string): void {
  let props = s.touched.get(el);
  if (!props) s.touched.set(el, (props = new Set()));
  if (!props.has(prop)) {
    props.add(prop);
    if (!s.attrs.has(el)) s.attrs.set(el, { attr: el.getAttribute("style"), cssText: el.style.cssText });
    s.saved.push({ el, prop, value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) });
  }
  el.style.setProperty(prop, value, "important");
}

// 문서(열린 shadow root 포함)의 요소. 너무 큰 문서는 앞부분만 본다.
function allElements(): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (root: Document | ShadowRoot) => {
    for (const el of root.querySelectorAll("*")) {
      if (out.length >= MAX_SCAN) return;
      // style을 가진 요소(HTML·SVG)만. 다른 창(프레임)의 생성자로 만든 요소도 있어 instanceof 대신 속성으로 본다.
      if ("style" in el) out.push(el as HTMLElement);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return out;
}

// 문서(화면)가 세로로 스크롤될 수 있는지(구조: 계산 스타일 overflow). html이 visible이면 body의 overflow가 화면에 쓰인다.
function docScrollable(): boolean {
  const hidden = (v: string) => v === "hidden" || v === "clip";
  const root = getComputedStyle(document.documentElement).overflowY;
  if (hidden(root)) return false;
  if (root === "visible" && document.body && hidden(getComputedStyle(document.body).overflowY)) return false;
  return true;
}

// 스크롤해 담을 문서 높이. 문서가 스크롤되지 않으면 보이는 높이.
function pageHeight(): number {
  const doc = document.documentElement;
  if (!docScrollable()) return doc.clientHeight;
  return Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0);
}

// 문서는 스크롤되지 않는데 화면의 큰 영역이 안쪽에서 스크롤되는 페이지인지(구조: 계산 스타일 overflow와 크기).
function hasInnerScroll(els: HTMLElement[]): boolean {
  if (pageHeight() > document.documentElement.clientHeight + 1) return false;
  const area = innerWidth * innerHeight;
  for (const el of els) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height >= area * 0.3) return true;
  }
  return false;
}

// 다음 그리기 뒤. 탭이 가려져 그리기가 멈춰도 오래 붙잡지 않는다.
function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
    setTimeout(resolve, 100);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function armIdleRestore(s: Session): void {
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    if (session === s) restore();
  }, IDLE_RESTORE_MS);
}

function restore(): void {
  const s = session;
  if (!s) return;
  session = null;
  if (s.timer) clearTimeout(s.timer);
  for (const p of s.saved.reverse()) {
    try {
      if (p.value) p.el.style.setProperty(p.prop, p.value, p.priority);
      else p.el.style.removeProperty(p.prop);
    } catch {
      /* 요소가 사라졌으면 그대로 */
    }
  }
  for (const [el, a] of s.attrs) {
    if (el.style.cssText !== a.cssText) continue;
    // 속성 글자를 먼저 읽어 CSSOM 변경을 속성에 반영시킨 뒤 지운다(반영이 늦게 일어나면 지운 뒤 빈 style=""이 생긴다).
    if (el.getAttribute("style") === a.attr) continue;
    if (a.attr === null) el.removeAttribute("style");
    else el.setAttribute("style", a.attr);
  }
  window.scrollTo({ left: s.scrollX, top: s.scrollY, behavior: "instant" });
}

// 시작: 문서를 재고, 전체 캡처면 세션을 연다(sticky → relative, 스크롤 스냅 끔).
export function captureBegin(fullPage: boolean): CaptureMetrics {
  // 이전 세션이 남아 있으면 먼저 되돌린다.
  restore();
  const pdf = document.contentType === "application/pdf";
  const doc = document.documentElement;
  const token = crypto.randomUUID();
  const els = fullPage && !pdf ? allElements() : [];
  const metrics: CaptureMetrics = {
    token,
    pdf,
    pageHeight: pageHeight(),
    pageWidth: Math.max(doc.scrollWidth, document.body?.scrollWidth ?? 0),
    viewportWidth: doc.clientWidth,
    viewportHeight: doc.clientHeight,
    windowWidth: innerWidth,
    scale: devicePixelRatio || 1,
    innerScroll: fullPage && !pdf ? hasInnerScroll(els) : false,
  };
  if (!fullPage || pdf) return metrics;
  const s: Session = { token, scrollX, scrollY, saved: [], attrs: new Map(), touched: new WeakMap(), timer: null };
  session = s;
  // 스크롤 스냅이 정한 위치로 끌려가지 않게 한다(scroll-behavior는 behavior: "instant"로 무시된다).
  setImportant(s, doc, "scroll-snap-type", "none");
  if (document.body) setImportant(s, document.body, "scroll-snap-type", "none");
  for (const el of els) {
    if (getComputedStyle(el).position !== "sticky") continue;
    // sticky의 top 등은 붙는 기준이라, relative에서 오프셋으로 쓰이지 않게 함께 auto로 둔다.
    setImportant(s, el, "position", "relative");
    for (const side of ["top", "right", "bottom", "left"]) setImportant(s, el, side, "auto");
  }
  armIdleRestore(s);
  return metrics;
}

function current(token: string): Session {
  if (!session || session.token !== token) throw new Error("캡처 세션이 없습니다(페이지가 바뀌었거나 시간이 지나 되돌렸습니다).");
  armIdleRestore(session);
  return session;
}

// 화면 안에서 아직 뜨지 않은 이미지(지연 로딩 포함).
function pendingImages(): HTMLImageElement[] {
  const out: HTMLImageElement[] = [];
  for (const img of document.images) {
    if (img.complete) continue;
    const r = img.getBoundingClientRect();
    if (r.bottom > 0 && r.top < innerHeight && r.width > 0 && r.height > 0) out.push(img);
  }
  return out;
}

export async function captureScroll(token: string, y: number): Promise<CaptureScrolled> {
  const s = current(token);
  window.scrollTo({ left: 0, top: y, behavior: "instant" });
  await frame();
  await frame();
  await sleep(SETTLE_MS);
  const until = Date.now() + LAZY_WAIT_MS;
  while (Date.now() < until && pendingImages().length) await sleep(100);
  await frame();
  armIdleRestore(s);
  return { y: window.scrollY, pageHeight: pageHeight() };
}

// 첫 화면 뒤: 보이는 fixed 요소를 투명하게 숨긴다(스크롤하며 새로 fixed가 된 것도 매번 다시 찾는다).
export async function captureHideFixed(token: string): Promise<number> {
  const s = current(token);
  let n = 0;
  for (const el of allElements()) {
    if (s.touched.get(el)?.has("opacity")) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" || cs.display === "none") continue;
    setImportant(s, el, "transition", "none");
    setImportant(s, el, "opacity", "0");
    n++;
  }
  await frame();
  await frame();
  return n;
}

export function captureEnd(token: string): boolean {
  if (!session || session.token !== token) return false;
  restore();
  return true;
}
