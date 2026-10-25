import type { CaptureMeasured, CaptureMetrics, CaptureScrolled } from "@/lib/pageCapture";

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
  // 이 세션이 마지막으로 바꾼 직후의 해석 결과. 되돌릴 때 이것과 같고 pageChanged가 아니면 그 사이 페이지가 inline
  // 스타일을 건드리지 않은 것이라 원래 속성 글자를 통째로 되돌린다(shorthand를 지우면 함께 지워지는 longhand까지, #65).
  after: string;
  // 이 세션이 다시 바꾸기 전에 페이지가 바꾼 적이 있는지(그 변경은 통째 되돌리기로 지우지 않는다).
  pageChanged: boolean;
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
  // 이 세션이 이미 바꾼 요소를 다시 바꾸기 전에 그 사이 페이지가 바꿨는지 기록한다(새 속성이든 같은 속성이든).
  const known = s.attrs.get(el);
  if (known && el.style.cssText !== known.after) known.pageChanged = true;
  if (!props.has(prop)) {
    props.add(prop);
    if (!known) s.attrs.set(el, { attr: el.getAttribute("style"), cssText: el.style.cssText, after: "", pageChanged: false });
    s.saved.push({ el, prop, value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) });
  }
  el.style.setProperty(prop, value, "important");
  const a = s.attrs.get(el);
  if (a) a.after = el.style.cssText;
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

// 보이는 영역(스크롤 막대 제외, CSS px). 표준 모드는 html의 client 크기, Quirks 모드(DOCTYPE 없음)는 body의 client
// 크기가 보이는 영역이다(그때 html의 clientHeight는 문서 높이).
function viewport(): { width: number; height: number } {
  const el = document.compatMode === "BackCompat" && document.body ? document.body : document.documentElement;
  return { width: el.clientWidth, height: el.clientHeight };
}

// 스크롤해 담을 문서 높이. 문서가 스크롤되지 않으면 보이는 높이.
function pageHeight(): number {
  const doc = document.documentElement;
  if (!docScrollable()) return viewport().height;
  return Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0);
}

// 문서는 스크롤되지 않는데 화면의 큰 영역이 안쪽에서 스크롤되는 페이지인지(구조: 계산 스타일 overflow와 크기).
function hasInnerScroll(els: HTMLElement[]): boolean {
  if (pageHeight() > viewport().height + 1) return false;
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
  // 페이지가 그 사이 inline 스타일을 건드리지 않은 요소는 원래 속성 글자를 통째로 되돌린다.
  const whole = new Set<HTMLElement>();
  for (const [el, a] of s.attrs) {
    try {
      if (a.pageChanged || el.style.cssText !== a.after) continue;
      if (a.attr === null) el.removeAttribute("style");
      else el.setAttribute("style", a.attr);
      whole.add(el);
    } catch {
      /* 요소가 사라졌으면 그대로 */
    }
  }
  // 페이지가 바꾼 요소는 그 변경을 두고 우리가 바꾼 속성만 되돌린다.
  for (const p of s.saved.reverse()) {
    if (whole.has(p.el)) continue;
    try {
      if (p.value) p.el.style.setProperty(p.prop, p.value, p.priority);
      else p.el.style.removeProperty(p.prop);
    } catch {
      /* 요소가 사라졌으면 그대로 */
    }
  }
  for (const [el, a] of s.attrs) {
    if (whole.has(el)) continue;
    if (el.style.cssText !== a.cssText) continue;
    // 속성 글자를 먼저 읽어 CSSOM 변경을 속성에 반영시킨 뒤 지운다(반영이 늦게 일어나면 지운 뒤 빈 style=""이 생긴다).
    if (el.getAttribute("style") === a.attr) continue;
    if (a.attr === null) el.removeAttribute("style");
    else el.setAttribute("style", a.attr);
  }
  window.scrollTo({ left: s.scrollX, top: s.scrollY, behavior: "instant" });
}

// 시작: 문서를 재고, 전체 캡처면 세션을 연다(sticky → relative, 스크롤 스냅 끔).
// token은 백그라운드가 만든 세션 값이다. 페이지가 비보안 컨텍스트(http·LAN 주소)면 crypto.randomUUID가 없어
// 여기서 만들지 않는다(백그라운드가 시작 응답을 받지 못해도 그 값으로 복원을 보낼 수 있다).
export function captureBegin(fullPage: boolean, token: string): CaptureMetrics {
  // 이전 세션이 남아 있으면 먼저 되돌린다.
  restore();
  const pdf = document.contentType === "application/pdf";
  const doc = document.documentElement;
  const els = fullPage && !pdf ? allElements() : [];
  const vp = viewport();
  const metrics: CaptureMetrics = {
    token,
    pdf,
    pageHeight: pageHeight(),
    pageWidth: Math.max(doc.scrollWidth, document.body?.scrollWidth ?? 0),
    viewportWidth: vp.width,
    viewportHeight: vp.height,
    windowWidth: innerWidth,
    windowHeight: innerHeight,
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
  const vp = viewport();
  return {
    x: window.scrollX,
    y: window.scrollY,
    pageHeight: pageHeight(),
    viewportWidth: vp.width,
    viewportHeight: vp.height,
    windowWidth: innerWidth,
    windowHeight: innerHeight,
    scale: devicePixelRatio || 1,
  };
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

// 찍은 뒤 다시 잰다(찍는 사이 창 크기·배율이 바뀌었는지).
export function captureMeasure(token: string): CaptureMeasured {
  current(token);
  const vp = viewport();
  return {
    viewportWidth: vp.width,
    viewportHeight: vp.height,
    windowWidth: innerWidth,
    windowHeight: innerHeight,
    scale: devicePixelRatio || 1,
    x: window.scrollX,
    y: window.scrollY,
  };
}

export function captureEnd(token: string): boolean {
  if (!session || session.token !== token) return false;
  restore();
  return true;
}
