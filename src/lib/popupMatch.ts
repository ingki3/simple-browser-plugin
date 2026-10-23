// 클릭 동안 페이지가 부른 window.open과 실제로 만들어진 탭·창을 맞춰, 브라우저가 막은 호출만 고른다(DOM 없이 계산).
// window.open은 막혔을 때뿐 아니라 noopener 창이 열렸을 때도 null을 돌려준다. 그래서 null만으로 막혔다고 보지 않고,
// 같은 주소로 만들어진 탭·창이 없을 때만 막힌 것으로 본다. 주소가 다른 새 탭(링크로 연 탭 등)이나 성공한(창을 돌려준)
// 호출이 연 탭은 막힌 호출을 가리지 않는다.

export interface OpenCallRecord {
  // 페이지가 넘긴 주소를 문서 기준으로 푼 것. 주소 없이 부르면 "about:blank".
  url: string;
  // window.open이 null을 돌려줬는지.
  blocked: boolean;
  // url이 기록 한도(OPEN_URL_MAX)를 넘어 잘렸는지.
  urlClipped?: boolean;
  // 세 번째 인자(창 옵션) 원문. 한도(OPEN_FEATURES_MAX)를 넘었거나 읽지 못했으면 null.
  features?: string | null;
}

export const OPEN_URL_MAX = 2000;
export const OPEN_FEATURES_MAX = 1000;
// 프레임마다 기록하는 window.open 호출 수 한도. 넘으면 기록이 완전하지 않다.
export const OPEN_CALLS_MAX = 5;

export const ABORTED: unique symbol = Symbol("aborted");

// p를 기다리되 ms가 지나면 fallback, signal이 중단되면 ABORTED로 끝낸다. p의 거부도 fallback으로 받는다 — 이미 중단돼
// 기다리지 않고 끝낼 때도 p에 거부 처리기를 달아(닫힌 탭에 대한 executeScript 실패 등) 처리되지 않은 거부가 남지 않게 한다.
export function bounded<T>(p: Promise<T>, ms: number, fallback: T, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal?.aborted) {
    p.catch(() => {});
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve) => {
    const done = (v: T | typeof ABORTED) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const onAbort = () => done(ABORTED);
    const timer = setTimeout(() => done(fallback), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(done, () => done(fallback));
  });
}

// 비교용 주소: 절대 주소로 정규화하고 해시는 뺀다. 빈 주소는 about:blank.
export function openTargetKey(url: string): string {
  if (!url) return "about:blank";
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

// 이미 열린 이름 있는 창을 다시 쓴 window.open(window.open(url, "calendar", …)이 같은 이름의 창을 찾아 그 창을
// 이동시킨다 — 새 탭이 만들어지지 않는다). 클릭 동안 다른 탭에서 시작된 이동 중, 창을 돌려준(성공한) 호출과 주소가
// 같은 것만 고른다(호출 하나에 이동 하나). navigations는 이동이 시작된 순서.
export function reusedTargets<T extends { url: string }>(opens: readonly OpenCallRecord[], navigations: readonly T[]): T[] {
  const wanted = opens.filter((c) => !c.blocked).map((c) => openTargetKey(c.url));
  const out: T[] = [];
  for (const n of navigations) {
    const i = wanted.indexOf(openTargetKey(n.url));
    if (i < 0) continue;
    wanted.splice(i, 1);
    out.push(n);
  }
  return out;
}

// 막힌 호출들(null을 돌려줬고 같은 주소로 만들어진 탭·창이 없는 것). createdUrls는 그 클릭 동안 만들어진 탭·창이
// 처음 가려던 주소(탐색 대상 주소·pendingUrl).
export function blockedOpens(opens: readonly OpenCallRecord[], createdUrls: readonly string[]): OpenCallRecord[] {
  const pool = createdUrls.map(openTargetKey);
  const take = (url: string): boolean => {
    const i = pool.indexOf(openTargetKey(url));
    if (i < 0) return false;
    pool.splice(i, 1);
    return true;
  };
  // 창을 돌려준(성공한) 호출이 연 탭을 먼저 짝지어, 그 탭이 같은 주소의 막힌 호출을 가리지 않게 한다.
  for (const c of opens) if (!c.blocked) take(c.url);
  return opens.filter((c) => c.blocked && !take(c.url));
}

// ── 창 옵션(window.open의 세 번째 인자)이 팝업을 요청하는지: HTML 표준 그대로(뜻 추론이 아닌 구문 해석) ──
// https://html.spec.whatwg.org/multipage/nav-history-apis.html#check-if-a-popup-window-is-requested

const isAsciiWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
const isSeparator = (c: string) => isAsciiWs(c) || c === "=" || c === ",";
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

const FEATURE_NAME_ALIASES: Record<string, string> = {
  screenx: "left",
  screeny: "top",
  innerwidth: "width",
  innerheight: "height",
};

// 표준 "tokenize the features argument". 같은 이름이 여러 번 나오면 뒤의 값.
export function tokenizeFeatures(features: string): Map<string, string> {
  const out = new Map<string, string>();
  let pos = 0;
  const n = features.length;
  while (pos < n) {
    while (pos < n && isSeparator(features[pos])) pos++;
    let start = pos;
    while (pos < n && !isSeparator(features[pos])) pos++;
    let name = asciiLower(features.slice(start, pos));
    name = FEATURE_NAME_ALIASES[name] ?? name;
    let value = "";
    while (pos < n && features[pos] !== "=") {
      if (features[pos] === "," || !isSeparator(features[pos])) break;
      pos++;
    }
    if (pos < n && isSeparator(features[pos])) {
      while (pos < n && isSeparator(features[pos])) {
        if (features[pos] === ",") break;
        pos++;
      }
      start = pos;
      while (pos < n && !isSeparator(features[pos])) pos++;
      value = asciiLower(features.slice(start, pos));
    }
    if (name !== "") out.set(name, value);
  }
  return out;
}

// 표준 "rules for parsing integers"(앞 공백, 부호, 앞쪽 숫자만). 숫자가 없으면 null.
function parseInteger(value: string): number | null {
  let pos = 0;
  while (pos < value.length && isAsciiWs(value[pos])) pos++;
  let sign = 1;
  if (value[pos] === "-") {
    sign = -1;
    pos++;
  } else if (value[pos] === "+") {
    pos++;
  }
  const start = pos;
  while (pos < value.length && value[pos] >= "0" && value[pos] <= "9") pos++;
  if (pos === start) return null;
  return sign * Number(value.slice(start, pos));
}

// 표준 "parse a boolean feature": 빈 값·yes·true는 참, 그 밖은 정수로 읽어(실패하면 0) 0이 아니면 참.
export function parseBooleanFeature(value: string): boolean {
  if (value === "" || value === "yes" || value === "true") return true;
  const parsed = parseInteger(value) ?? 0;
  return parsed !== 0;
}

// window.open 절차대로 noopener·noreferrer를 해석해 빼낸 뒤 "check if a popup window is requested"를 적용한다.
// noopener(noreferrer 포함)면 window.open이 null을 돌려주므로 popup은 의미가 없어 false.
export function popupRequested(features: string): boolean {
  const tokens = tokenizeFeatures(features);
  let noopener = false;
  if (tokens.has("noopener")) {
    noopener = parseBooleanFeature(tokens.get("noopener") as string);
    tokens.delete("noopener");
  }
  if (tokens.has("noreferrer")) {
    if (parseBooleanFeature(tokens.get("noreferrer") as string)) noopener = true;
    tokens.delete("noreferrer");
  }
  if (noopener) return false;
  if (tokens.size === 0) return false;
  if (tokens.has("popup")) return parseBooleanFeature(tokens.get("popup") as string);
  const isSet = (name: string, dflt: boolean) => (tokens.has(name) ? parseBooleanFeature(tokens.get(name) as string) : dflt);
  if (!isSet("location", false) && !isSet("toolbar", false)) return true;
  if (!isSet("menubar", false)) return true;
  if (!isSet("resizable", true)) return true;
  if (!isSet("scrollbars", false)) return true;
  if (!isSet("status", false)) return true;
  return false;
}

// 팝업을 요청한 window.open이 브라우저 사정(macOS 전체 화면 등)으로 일반 창의 탭으로 열렸을 때, 그 탭을 팝업처럼
// 따라가도 되는지. 모두 브라우저가 알려 준 사실과 기록의 구문으로만 정한다. 따라가도 되면 null, 아니면 이유.
// - opensComplete: 모든 프레임의 기록을 한도 안에서 빠짐없이 읽었는지.
// - freshCount: 이 클릭 동안 브라우저 관계(탐색 대상·opener)로 새로 만들어진 탭 수(닫힌 탭 포함, 다시 쓴 창 제외).
// - tab: 후보 탭의 지금 상태(committedUrl은 최상위 문서가 확정된 주소, pending은 아직 이동 중인지).
export function popupTabIneligible(input: {
  opensComplete: boolean;
  opens: readonly OpenCallRecord[];
  freshCount: number;
  sourceWindowId: number;
  tab: { windowId: number; windowType: string; active: boolean; committedUrl: string | null; pending: boolean };
}): string | null {
  const { opens, tab } = input;
  if (tab.windowType !== "normal") return `창 종류 ${tab.windowType}`;
  if (!input.opensComplete) return "window.open 기록이 완전하지 않음";
  if (input.freshCount !== 1) return `새 탭이 ${input.freshCount}개`;
  const ok = opens.filter((c) => !c.blocked);
  if (ok.length !== 1) return `성공한 window.open이 ${ok.length}개`;
  const call = ok[0];
  if (call.urlClipped) return "window.open 주소가 기록 한도를 넘음";
  if (call.features == null) return "창 옵션을 확인할 수 없음";
  if (!popupRequested(call.features)) return "팝업을 요청하지 않은 window.open";
  if (tab.windowId !== input.sourceWindowId) return "클릭한 탭과 다른 창";
  if (!tab.active) return "앞에 보이지 않는 탭";
  if (tab.pending || tab.committedUrl === null) return "탭이 아직 이동 중";
  if (tab.committedUrl !== call.url) return "탭 주소가 window.open 주소와 다름";
  return null;
}
