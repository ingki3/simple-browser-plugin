// read_links_in_tabs(#293): 지금 페이지의 링크를 로그인된 상태(사용자 쿠키)로 비활성 탭에서 열어 본문을 읽고 닫는다.
// 이 파일은 chrome을 부르지 않는 판단·실행 순서(단위 시험 대상)이고, chrome 호출은 background/linkTabs.ts가 deps로 넘긴다.
// 판단은 주소의 구조(스킴·계정 정보·페이지에 글자 그대로 있는 href·파일 확장자)와 기존 결제·개인정보 주소 신호(더 막는 쪽)로만 한다.
import { createSerial, raceSignal } from "./async.ts";
import { sensitiveUrlReason } from "./autoApprove.ts";
import { checkFileUrl, extensionOf, isWebResourceExtension, saveOnlyExtension } from "./fileFormat.ts";
import { structuralReject } from "./linkRedirect.ts";
import { siteOf, withinSite } from "./siteTrust.ts";

export const MAX_TAB_LINK_READS_PER_TURN = 2;
export const MAX_TAB_LINKS = 8;
export const TAB_LINK_CONCURRENCY = 2;
export const OPEN_TABS_KEY = "linkTabs:open";
export const TAB_LINK_AUTO_BLOCK = "로그인된 탭으로 여는 읽기는 늘 확인";
export const ABORTED_TEXT = "사용자가 중단했습니다.";
export const USER_TAB_TEXT = "사용자가 이 탭을 열어 읽지 않았습니다. 탭은 그대로 둡니다.";
export const CHANGED_TEXT = "읽는 사이 페이지가 바뀌어 읽은 글을 버렸습니다.";
export const EMPTY_TEXT =
  "본문을 찾지 못했습니다(뒤에서 연 탭에서는 그리지 않는 페이지일 수 있음). 이 링크가 꼭 필요하면 navigate_to_url로 열어 get_page_content로 읽으세요.";

export interface TabLinkLimits {
  // 링크 하나의 전체 기한(로딩·대기·읽기 포함).
  linkMs: number;
  // 로딩(status complete)까지의 한도.
  loadMs: number;
  // 다 뜬 뒤 그리기를 기다리는 시간.
  settleMs: number;
  // 본문 읽기(전송·주입·재시도 전체)의 기한.
  readMs: number;
  // 로딩 확인 간격.
  pollMs: number;
}

export const TAB_LINK_LIMITS: TabLinkLimits = { linkMs: 30_000, loadMs: 20_000, settleMs: 800, readMs: 10_000, pollMs: 300 };

const PER_LINK_CHARS = 4_000;
const TOTAL_CHARS = 24_000;
const SHORT_CHARS = 200;

// 링크 하나에 줄 글자 수(고른 링크 수 n).
export function perLinkChars(n: number): number {
  return Math.min(PER_LINK_CHARS, Math.floor(TOTAL_CHARS / Math.max(1, n)));
}

export function clipUrl(url: string, max = 200): string {
  return url.length > max ? `${url.slice(0, max - 1)}…` : url;
}

// 탭에서 열면 내려받기가 시작될 수 있는 파일 주소인지: read_document가 읽을 수 있는 파일로 본 주소(확장자·쿼리의 파일 이름),
// 확장자 때문에 거절한 주소(구형 Office·압축·실행 파일·이미지 등). 웹 페이지 확장자(.html 등)와 확장자 없는 주소는 통과.
export function fileLinkReason(url: string): string | null {
  const checked = checkFileUrl(url);
  if (checked.ok) return checked.target.hint ? `파일 링크(${checked.target.hint})` : null;
  const ext = saveOnlyExtension(url);
  if (ext) return `파일 링크(.${ext})`;
  // checkFileUrl이 거절한 나머지 중 웹 페이지 확장자만 통과시키고, 경로를 풀 수 없는 주소 등은 막는다(더 막는 쪽).
  let last: string | null = null;
  try {
    last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    last = null;
  }
  const pathExt = last === null ? null : extensionOf(last);
  if (pathExt && isWebResourceExtension(pathExt)) return null;
  return `파일로 보이는 주소(${checked.reason})`;
}

// 탭으로 열 수 없는 주소의 이유(구조 → 결제·개인정보 신호 → 파일). 없으면 null.
export function tabUrlReject(url: string): string | null {
  const structural = structuralReject(url);
  if (structural) return structural;
  const sensitive = sensitiveUrlReason(url);
  if (sensitive) return `${sensitive} 신호`;
  return fileLinkReason(url);
}

// 지금 페이지(exact 조회)에 글자 그대로 있는 href인지와 그 링크 글자. 없으면 null.
export type PageLinkLookup = (url: string) => { text: string } | null;

export type TabLinkPlan =
  | { ok: true; open: string; text: string; viaRedirect: boolean }
  | { ok: false; reason: string };

// 입력 주소 하나의 판정. look: exact 조회 결과, pageLinkFor: 이 턴에 read_linked_pages가 기억한 다른 사이트 리다이렉트 목적지 → 원래 링크.
// 1) 입력이 페이지에 글자 그대로 있으면 그 주소를 연다. 2) 아니면 기억한 목적지면 원래 페이지 링크(그것도 페이지에 글자 그대로
// 있어야 함)를 연다(브라우저가 리다이렉트를 따라가게). 3) 그 밖은 거절. 거절 검사는 입력 주소와 열 주소 모두에 한다.
export function tabLinkPlan(url: string, look: PageLinkLookup, pageLinkFor: (url: string) => string | null): TabLinkPlan {
  const inputReject = tabUrlReject(url);
  if (inputReject) return { ok: false, reason: inputReject };
  const direct = look(url);
  let open: string;
  let text: string;
  let viaRedirect = false;
  if (direct) {
    open = url;
    text = direct.text;
  } else {
    const pageLink = pageLinkFor(url);
    if (!pageLink) return { ok: false, reason: "지금 페이지에 없는 링크" };
    const original = look(pageLink);
    if (!original) return { ok: false, reason: "리다이렉트한 원래 링크가 지금 페이지에 그대로 있지 않음" };
    open = pageLink;
    text = original.text;
    viaRedirect = true;
  }
  if (open !== url) {
    const openReject = tabUrlReject(open);
    if (openReject) return { ok: false, reason: `여는 원래 링크: ${openReject}` };
  }
  return { ok: true, open, text, viaRedirect };
}

export interface TabCandidate {
  choiceId: string;
  // 탭으로 열 주소(페이지의 href 그대로, 해시 포함).
  open: string;
  label: string;
  sub: string;
}

// 카드 후보 만들기: 입력마다 판정하고, 같은 열 주소로 모이는 입력은 하나로 합친다. 거절한 주소는 rejected에(120자로 줄여).
export function planTabCandidates(
  urls: readonly string[],
  look: PageLinkLookup,
  pageLinkFor: (url: string) => string | null,
  pageUrl: string,
  newId: () => string,
): { list: TabCandidate[]; rejected: string[] } {
  const list: TabCandidate[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  const pageSite = siteOf(pageUrl);
  for (const url of urls.slice(0, MAX_TAB_LINKS)) {
    const plan = tabLinkPlan(url, look, pageLinkFor);
    if (!plan.ok) {
      rejected.push(`${url.slice(0, 120)} (${plan.reason})`);
      continue;
    }
    if (seen.has(plan.open)) continue;
    seen.add(plan.open);
    const other = pageSite && withinSite(pageSite, plan.open) ? "" : "다른 사이트";
    const via = plan.viaRedirect ? "리다이렉트 목적지 대신 페이지의 원래 링크를 엶" : "";
    const notes = [other, via].filter(Boolean).join(" · ");
    list.push({ choiceId: newId(), open: plan.open, label: plan.text || plan.open, sub: notes ? `${plan.open} (${notes})` : plan.open });
  }
  return { list, rejected };
}

// 다 뜬 탭의 최종 주소를 읽어도 되는지. 다른 사이트로 넘어간 것 자체는 허용한다(finalUrl로 알림).
export function finalUrlBlock(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return "웹 페이지가 아닌 주소로 열려 읽지 않았습니다.";
  const structural = structuralReject(url);
  if (structural) return `읽지 않는 주소(${structural})로 넘어가 읽지 않았습니다.`;
  const sensitive = sensitiveUrlReason(url);
  if (sensitive) return `결제·개인정보 신호가 있는 주소(${clipUrl(url)})로 넘어가 읽지 않았습니다.`;
  return null;
}

export type TabRead =
  | { url: string; finalUrl?: string; title: string; text: string; truncated: boolean; short?: true }
  | { url: string; finalUrl?: string; error: string };

// 읽은 본문을 결과로. 빈 본문은 오류.
export function tabReadResult(open: string, finalUrl: string, title: string, mainText: string, maxChars: number): TabRead {
  const moved = finalUrl && finalUrl !== open ? { finalUrl } : {};
  const trimmed = mainText.trim();
  if (!trimmed) return { url: open, ...moved, error: EMPTY_TEXT };
  const text = trimmed.slice(0, maxChars);
  return {
    url: open,
    ...moved,
    title: title.slice(0, 200),
    text,
    truncated: text.length < trimmed.length,
    ...(text.length < SHORT_CHARS ? { short: true as const } : {}),
  };
}

// ---- 실행(주입형) ----

export interface TabInfo {
  url?: string;
  status?: string;
  active?: boolean;
}

export interface TabLinkDeps {
  // 턴 탭의 창·위치. 닫혔거나 시크릿이면 오류를 던진다.
  turnTab(): Promise<{ windowId: number; index: number }>;
  create(opts: { url: string; windowId: number; index: number }): Promise<{ id?: number }>;
  // 없으면 null.
  get(tabId: number): Promise<TabInfo | null>;
  remove(tabId: number): Promise<void>;
  mute(tabId: number): Promise<void>;
  topDocumentId(tabId: number): Promise<string | null>;
  // 그 문서에 본문 읽기를 보낸다(받는 쪽이 없으면 주입·재시도). signal이 끊기면 재시도를 멈춘다.
  readText(tabId: number, documentId: string, expectUrl: string, signal: AbortSignal): Promise<{ url: string; title: string; mainText: string }>;
  loadOwned(): Promise<number[]>;
  saveOwned(ids: number[]): Promise<void>;
  log(tag: string, msg: string, level?: "warn"): void;
}

// 이 도구가 연 탭 목록(메모리 + 저장소). 저장소 갱신은 한 줄로 세운 읽기-고치기-쓰기다(동시 작업자가 서로의 갱신을 덮지 않게).
export class TabOwnership {
  private readonly mem = new Set<number>();
  private readonly touched = new Set<number>();
  private readonly serial = createSerial();
  private readonly deps: Pick<TabLinkDeps, "get" | "remove" | "loadOwned" | "saveOwned" | "log">;
  constructor(deps: Pick<TabLinkDeps, "get" | "remove" | "loadOwned" | "saveOwned" | "log">) {
    this.deps = deps;
  }

  has(tabId: number): boolean {
    return this.mem.has(tabId);
  }

  // 사용자가 앞으로 가져온 탭(onActivated). 이 도구가 연 탭이면 표시만 한다.
  noteActivated(tabId: number): void {
    if (this.mem.has(tabId)) this.touched.add(tabId);
  }

  isTouched(tabId: number): boolean {
    return this.touched.has(tabId);
  }

  add(tabId: number): Promise<void> {
    this.mem.add(tabId);
    return this.serial(async () => {
      const ids = await this.deps.loadOwned().catch(() => [] as number[]);
      if (!ids.includes(tabId)) await this.deps.saveOwned([...ids, tabId]);
    }).catch(() => {});
  }

  drop(tabId: number): Promise<void> {
    this.mem.delete(tabId);
    this.touched.delete(tabId);
    return this.serial(async () => {
      const ids = await this.deps.loadOwned().catch(() => [] as number[]);
      if (ids.includes(tabId)) await this.deps.saveOwned(ids.filter((id) => id !== tabId));
    }).catch(() => {});
  }

  // 닫기: 사용자가 건드린 탭(앞으로 가져옴·지금 활성)은 닫지 않고 목록에서만 뺀다("user"). 닫았거나 이미 없으면 뺀다("closed").
  // 닫기에 실패하면 목록에 남긴다("kept" — 다음 초기 청소가 다시 시도).
  async close(tabId: number): Promise<"closed" | "user" | "kept"> {
    const tab = await this.deps.get(tabId).catch(() => undefined);
    if (tab === null) {
      await this.drop(tabId);
      return "closed";
    }
    if (this.touched.has(tabId) || tab?.active) {
      await this.drop(tabId);
      return "user";
    }
    try {
      await this.deps.remove(tabId);
    } catch {
      const again = await this.deps.get(tabId).catch(() => undefined);
      if (again !== null) return "kept";
    }
    await this.drop(tabId);
    return "closed";
  }

  // 초기 청소(서비스 워커가 다시 뜸): 시작할 때 저장소에 있던 id만 다룬다. 활성 탭은 닫지 않고 목록에서만 빼고, 닫기에 실패한 것은 남긴다.
  async cleanup(): Promise<{ closed: number; kept: number }> {
    const ids = await this.serial(() => this.deps.loadOwned()).catch(() => [] as number[]);
    let closed = 0;
    let kept = 0;
    for (const id of ids) {
      const tab = await this.deps.get(id).catch(() => undefined);
      if (tab === null || tab?.active) {
        await this.drop(id);
        continue;
      }
      try {
        await this.deps.remove(id);
        closed++;
        await this.drop(id);
      } catch {
        const again = await this.deps.get(id).catch(() => undefined);
        if (again === null) await this.drop(id);
        else kept++;
      }
    }
    if (ids.length) this.deps.log("link_tabs:cleanup", `closed ${closed} kept ${kept}`);
    return { closed, kept };
  }
}

class UserAbort extends Error {
  constructor() {
    super(ABORTED_TEXT);
  }
}
class LinkFail extends Error {}
class UserTab extends Error {
  constructor() {
    super(USER_TAB_TEXT);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// 링크 하나: 탭 만들기 → 등록 → 로딩 → 최종 주소 검사 → 그 문서만 읽기 → 재확인 → 닫기(finally).
async function readOneTab(
  open: string,
  maxChars: number,
  deps: TabLinkDeps,
  owner: TabOwnership,
  user: AbortSignal,
  limits: TabLinkLimits,
): Promise<TabRead> {
  if (user.aborted) throw new UserAbort();
  // 링크 하나의 기한과 사용자 중단을 한 신호로 묶는다.
  const link = new AbortController();
  const timer = setTimeout(() => link.abort(), limits.linkMs);
  const onUser = () => link.abort();
  user.addEventListener("abort", onUser, { once: true });
  const stop = () => (user.aborted ? new UserAbort() : new LinkFail(`${Math.round(limits.linkMs / 1000)}초 안에 읽지 못했습니다.`));
  const bound = <T>(p: Promise<T>): Promise<T> => raceSignal(p, link.signal, stop);
  let tabId: number | null = null;
  let userTab = false;
  const checkUser = async (): Promise<TabInfo> => {
    const tab = await bound(deps.get(tabId!));
    if (!tab) throw new LinkFail("탭이 닫혔습니다.");
    if (owner.isTouched(tabId!) || tab.active) {
      userTab = true;
      throw new UserTab();
    }
    return tab;
  };
  try {
    const where = await bound(deps.turnTab());
    // 만들기 약속을 받은 즉시(다른 await 없이) 정리 책임을 잡는다: 탭 id를 받으면 메모리 목록에 먼저 넣고 저장소에 기록한다.
    // 기한·중단으로 기다리지 않게 된 뒤에 탭이 열리면 등록이 끝난 뒤 닫는다.
    const creating = deps.create({ url: open, windowId: where.windowId, index: where.index + 1 });
    const registered = creating.then(async (tab) => {
      if (tab.id === undefined) return null;
      await owner.add(tab.id);
      return tab.id;
    });
    registered.catch(() => {});
    try {
      tabId = await bound(registered);
    } catch (err) {
      void registered.then((id) => (id !== null ? owner.close(id) : undefined)).catch(() => {});
      throw err;
    }
    if (tabId === null) throw new LinkFail("탭을 열지 못했습니다.");
    void deps.mute(tabId).catch(() => {});
    // 로딩 대기.
    const loadUntil = Date.now() + limits.loadMs;
    for (;;) {
      const tab = await checkUser();
      if (tab.status === "complete") break;
      if (Date.now() >= loadUntil) throw new LinkFail(`페이지가 ${Math.round(limits.loadMs / 1000)}초 안에 다 뜨지 않았습니다.`);
      await sleep(limits.pollMs, link.signal).catch(() => {
        throw stop();
      });
    }
    await sleep(limits.settleMs, link.signal).catch(() => {
      throw stop();
    });
    const loaded = await checkUser();
    const finalUrl = loaded.url ?? "";
    const blocked = finalUrlBlock(finalUrl);
    if (blocked) return { url: open, finalUrl: clipUrl(finalUrl), error: blocked };
    const documentId = await bound(deps.topDocumentId(tabId));
    if (!documentId) throw new LinkFail("페이지 문서를 확인하지 못했습니다.");
    // 본문 읽기 직전 확인.
    await checkUser();
    // 전송·주입·재시도 전체에 하나의 기한. 기한·중단이면 바로 빠져나오고 늦게 온 응답은 버린다.
    const read = new AbortController();
    const readTimer = setTimeout(() => read.abort(), limits.readMs);
    const onLink = () => read.abort();
    link.signal.addEventListener("abort", onLink, { once: true });
    let got: { url: string; title: string; mainText: string };
    try {
      got = await raceSignal(deps.readText(tabId, documentId, finalUrl, read.signal), read.signal, () =>
        link.signal.aborted ? stop() : new LinkFail(`${Math.round(limits.readMs / 1000)}초 안에 본문을 읽지 못했습니다.`),
      );
    } finally {
      clearTimeout(readTimer);
      link.signal.removeEventListener("abort", onLink);
    }
    // 읽은 직후 확인: 사용자가 건드리지 않았고, 주소와 최상위 문서가 그대로일 때만 글을 쓴다.
    const after = await checkUser();
    const afterDoc = await bound(deps.topDocumentId(tabId));
    if (after.url !== finalUrl || afterDoc !== documentId || got.url !== finalUrl) {
      return { url: open, ...(finalUrl !== open ? { finalUrl } : {}), error: CHANGED_TEXT };
    }
    return tabReadResult(open, finalUrl, got.title, got.mainText, maxChars);
  } catch (err) {
    if (user.aborted) throw new UserAbort();
    if (err instanceof UserTab) return { url: open, error: USER_TAB_TEXT };
    const msg = err instanceof LinkFail ? err.message : "링크를 탭에서 읽지 못했습니다.";
    if (!(err instanceof LinkFail)) deps.log("link_tabs:error", err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200), "warn");
    return { url: open, error: msg };
  } finally {
    clearTimeout(timer);
    user.removeEventListener("abort", onUser);
    if (tabId !== null) {
      // 닫기 직전 확인(사용자가 건드린 탭은 닫지 않고 목록에서 뺀다).
      if (userTab) await owner.drop(tabId);
      else await owner.close(tabId);
    }
  }
}

// 고른 링크를 작업자 TAB_LINK_CONCURRENCY개로 읽는다. ready(초기 청소)를 기다린 뒤 시작한다. 중단되면 새 링크를 시작하지 않고,
// 모든 작업자의 정리(닫기 시도)가 끝난 뒤 "사용자가 중단했습니다."로 끝낸다.
export async function runTabReads(
  opens: readonly string[],
  deps: TabLinkDeps,
  owner: TabOwnership,
  ready: Promise<unknown>,
  signal: AbortSignal,
  limits: TabLinkLimits = TAB_LINK_LIMITS,
): Promise<TabRead[]> {
  await raceSignal(ready.catch(() => {}), signal, () => new UserAbort());
  if (signal.aborted) throw new UserAbort();
  const maxChars = perLinkChars(opens.length);
  const out: TabRead[] = new Array(opens.length);
  deps.log("link_tabs:open", String(opens.length));
  let next = 0;
  const worker = async () => {
    while (next < opens.length && !signal.aborted) {
      const i = next++;
      out[i] = await readOneTab(opens[i], maxChars, deps, owner, signal, limits);
      const r = out[i];
      deps.log("link_tabs:read", `${"error" in r ? `fail ${r.error.slice(0, 40)}` : "ok"} · ${clipUrl(opens[i], 120)}`, "error" in r ? "warn" : undefined);
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(TAB_LINK_CONCURRENCY, opens.length) }, worker));
  if (signal.aborted) throw new UserAbort();
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  return out;
}
