import type { ContentResponse } from "@/lib/messages";
import type { HtmlExtractJob, HtmlExtractResult } from "@/lib/documentJob";
import { decodeHtml } from "@/lib/htmlCharset";
import { sensitiveUrlReason } from "@/lib/autoApprove";
import { siteOf, withinSite } from "@/lib/siteTrust";
import { linkReadGrantBlock, type LinkFacts } from "@/lib/chatGrant";
import {
  MAX_LINK_REDIRECTS,
  RedirectMemory,
  blockedWithoutCookies,
  nextRedirectStep,
  requestUrl,
  structuralReject,
  type RedirectStep,
} from "@/lib/linkRedirect";
import { resolveTurnTab, type TurnTab } from "./tools/handlers";
import { runOffscreenJob } from "./offscreen";
import { debugLog } from "./debug";

// read_linked_pages: 지금 페이지에 실제로 있는 링크만, 쿠키 없이 받아 와 본문을 읽는다(탭 이동 없음).
// 카드를 띄우기 전에 후보(id·주소)를 고정하고, 사용자가 고른 id의 주소만 받아 온다.
// 리다이렉트는 같은 사이트(등록 도메인) 안에서만 몇 번 따라가고, 다른 사이트로 가면 목적지를 알리고 이 턴 동안 기억해
// 모델이 그 주소로 다시 부르면 페이지 링크처럼 새 카드의 후보로 받는다.

const PER_PAGE_CHARS = 4_000;
const TOTAL_CHARS = 24_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const EXTRACT_GUARD_MS = 15_000;
const CONCURRENCY = 4;
const SHORT_CHARS = 200;
const MAX_SNAPSHOTS = 20;
const LOOKUP_TIMEOUT_MS = 10_000;

interface Candidate {
  choiceId: string;
  url: string;
  text: string;
  // 리다이렉트 목적지 후보면 그 목적지로 리다이렉트한 페이지의 원래 링크.
  pageLink?: string;
}

interface Snapshot {
  turnTab: TurnTab;
  list: Candidate[];
}

export interface LinkChoice {
  id: string;
  label: string;
  sub: string;
}

const snapshots = new Map<string, Snapshot>();
const chosen = new Map<string, string[]>();
// 턴마다 새로 만드는 TurnTab(한 탭)에 묶어 두므로, 기억은 그 턴·그 탭 안에서만 쓰이고 턴이 끝나면 함께 사라진다.
const redirectMemory = new WeakMap<TurnTab, RedirectMemory>();

function memoryFor(turnTab: TurnTab): RedirectMemory {
  let m = redirectMemory.get(turnTab);
  if (!m) {
    m = new RedirectMemory();
    redirectMemory.set(turnTab, m);
  }
  return m;
}

export async function snapshotLinks(
  callId: string,
  turnTab: TurnTab,
  urls: string[],
): Promise<{ choices: LinkChoice[]; defaults: string[]; rejected: string[]; grantBlock: string | null }> {
  const tabId = await resolveTurnTab(turnTab);
  const pageUrl = (await chrome.tabs.get(tabId)).url ?? "";
  // 페이지가 응답하지 않아도(alert·긴 스크립트) 카드 만들기가 무기한 기다리지 않게 시간 제한을 둔다.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const res = (await Promise.race([
    chrome.tabs.sendMessage(tabId, { kind: "link_lookup", urls }, { frameId: 0 }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("페이지가 응답하지 않아 링크를 확인하지 못했습니다.")), LOOKUP_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer))) as ContentResponse<Array<{ url: string; present: boolean; text: string }>>;
  if (!res?.ok || !res.data) throw new Error(res?.error ?? "페이지의 링크를 확인하지 못했습니다.");
  const list: Candidate[] = [];
  const choices: LinkChoice[] = [];
  const defaults: string[] = [];
  const rejected: string[] = [];
  // 이번 대화 허락(#53) 판정용: 카드의 경고와 같은 구조적 사실.
  const facts: LinkFacts[] = [];
  const pageSite = siteOf(pageUrl);
  const memory = redirectMemory.get(turnTab);
  for (const item of res.data) {
    // 페이지에 없는 주소라도 이 턴에 페이지 링크가 다른 사이트로 리다이렉트한 목적지(결과로 알려 준 주소)면 후보로 받는다.
    const pageLink = item.present ? undefined : (memory?.pageLinkFor(item.url) ?? undefined);
    const reject = item.present || pageLink ? structuralReject(item.url) : "지금 페이지에 없는 링크";
    if (reject) {
      rejected.push(`${item.url.slice(0, 120)} (${reject})`);
      continue;
    }
    const choiceId = crypto.randomUUID();
    list.push({ choiceId, url: item.url, text: item.text, ...(pageLink ? { pageLink } : {}) });
    // 결제·개인정보 신호(키워드 포함)는 경고와 기본 미선택(더 묻기)으로만 쓴다.
    const warn = sensitiveUrlReason(item.url);
    const other = pageSite && !withinSite(pageSite, item.url) ? "다른 사이트" : "";
    // 허락 판정에서는 지금 페이지의 사이트를 알 수 없어도 다른 사이트로 본다(더 묻는 쪽).
    facts.push({ url: item.url, otherSite: !pageSite || !!other, redirected: !!pageLink });
    const via = pageLink ? `페이지 링크 ${pageLink.slice(0, 120)}가 리다이렉트한 주소` : "";
    const notes = [warn ? `⚠ ${warn} — 열기만 해도 동작하는 링크일 수 있음` : "", other, via].filter(Boolean).join(" · ");
    choices.push({ id: choiceId, label: item.text || item.url, sub: notes ? `${item.url} (${notes})` : item.url });
    if (!warn) defaults.push(choiceId);
  }
  if (!list.length) throw new Error(`읽을 수 있는 링크가 없습니다: ${rejected.join(", ")}`);
  snapshots.set(callId, { turnTab, list });
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
  return { choices, defaults, rejected, grantBlock: linkReadGrantBlock(facts, rejected.length) };
}

export function setChosenLinks(callId: string, ids: string[]): void {
  const known = new Set((snapshots.get(callId)?.list ?? []).map((c) => c.choiceId));
  chosen.set(callId, [...new Set(ids)].filter((id) => known.has(id)));
}

export function discardLinkCall(callId: string): void {
  snapshots.delete(callId);
  chosen.delete(callId);
}

type PageRead =
  | { url: string; finalUrl?: string; title: string; text: string; truncated: boolean; short?: true }
  | { url: string; finalUrl?: string; error: string; redirectTo?: string; blocked?: true };

interface ReadFailExtra {
  // 따라가지 않은 리다이렉트의 목적지.
  redirectTo?: string;
  // 쿠키 없이 받는 요청을 사이트가 막은 것으로 보임(탭에서 열어야 읽을 수 있음).
  blocked?: true;
}

class LinkReadError extends Error {
  constructor(
    message: string,
    readonly extra: ReadFailExtra = {},
  ) {
    super(message);
  }
}

// 이 서비스 워커가 보낸 요청이 받은 리다이렉트 응답의 목적지를 기록한다. fetch는 redirect: "error"면 목적지를
// 알려 주지 않고, redirect: "manual"은 확장에서도 Location을 감추므로 webRequest로 본다(관찰만 하고 요청을 바꾸지 않는다).
// url은 해시를 뺀 요청 주소(requestUrl).
// webRequest 이벤트는 fetch의 실패보다 늦게 도착할 수 있어(동시에 여러 링크를 받을 때), 실패 뒤에는 그 요청의 끝
// (오류·완료 이벤트, 같은 요청의 이벤트는 순서대로 온다)이나 목적지를 잠깐 기다린다.
const REDIRECT_EVENT_WAIT_MS = 1_000;

function watchRedirect(url: string): { settled(): Promise<string | null>; stop(): void } {
  let location: string | null = null;
  let ended = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const take = (value: string | undefined) => {
    if (!value || location) return;
    try {
      location = new URL(value, url).href;
    } catch {
      /* 주소가 아닌 Location은 기록하지 않음 */
    }
    notify();
  };
  const onHeaders = (d: chrome.webRequest.WebResponseHeadersDetails) => {
    if (d.tabId !== -1 || requestUrl(d.url) !== url || d.statusCode < 300 || d.statusCode >= 400) return;
    take(d.responseHeaders?.find((h) => h.name.toLowerCase() === "location")?.value);
  };
  // HSTS 승격처럼 브라우저 안에서 만든 리다이렉트는 응답 헤더 이벤트 없이 올 수 있어 함께 본다.
  const onRedirect = (d: chrome.webRequest.WebRedirectionResponseDetails) => {
    if (d.tabId !== -1 || requestUrl(d.url) !== url) return;
    take(d.redirectUrl);
  };
  const onEnd = (d: chrome.webRequest.WebResponseErrorDetails | chrome.webRequest.WebResponseCacheDetails) => {
    if (d.tabId !== -1 || requestUrl(d.url) !== url) return;
    ended = true;
    notify();
  };
  const filter = { urls: ["<all_urls>"] };
  chrome.webRequest.onHeadersReceived.addListener(onHeaders, filter, ["responseHeaders"]);
  chrome.webRequest.onBeforeRedirect.addListener(onRedirect, filter);
  chrome.webRequest.onErrorOccurred.addListener(onEnd, filter);
  chrome.webRequest.onCompleted.addListener(onEnd, filter);
  return {
    settled: async () => {
      if (!location && !ended) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, REDIRECT_EVENT_WAIT_MS);
        });
        clearTimeout(timer);
      }
      return location;
    },
    stop: () => {
      chrome.webRequest.onHeadersReceived.removeListener(onHeaders);
      chrome.webRequest.onBeforeRedirect.removeListener(onRedirect);
      chrome.webRequest.onErrorOccurred.removeListener(onEnd);
      chrome.webRequest.onCompleted.removeListener(onEnd);
    },
  };
}

// 같은 주소의 요청은 하나씩 보낸다. webRequest 이벤트를 주소로만 가려내므로, 같은 주소를 동시에 요청하면
// 서로의 리다이렉트 목적지가 섞일 수 있다.
const urlLocks = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const prev = urlLocks.get(url) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  urlLocks.set(url, tail);
  try {
    return await run;
  } finally {
    if (urlLocks.get(url) === tail) urlLocks.delete(url);
  }
}

function short(url: string): string {
  return url.length > 200 ? `${url.slice(0, 199)}…` : url;
}

// 따라가지 않은 리다이렉트를 모델에 알리는 오류. 다른 사이트 목적지만 이 턴에 기억한다(다시 부르면 새 카드).
function redirectStopError(step: Extract<RedirectStep, { kind: "stop" }>, memory: RedirectMemory, pageLink: string): LinkReadError {
  const to = short(step.url);
  switch (step.reason) {
    case "cross_site":
      memory.remember(step.url, pageLink);
      return new LinkReadError(
        `이 링크는 다른 사이트 주소로 리다이렉트됩니다: ${to}\n안전을 위해 다른 사이트로 가는 리다이렉트는 따라가지 않았습니다. 사용자가 원한 글로 보이면 read_linked_pages를 이 주소(redirectTo)로 한 번 다시 호출하세요(새 승인 카드가 뜹니다).`,
        { redirectTo: step.url },
      );
    case "sensitive":
      return new LinkReadError(
        `이 링크는 ${to}로 리다이렉트되는데, 그 주소에 ${step.detail} 신호가 있어 따라가지 않았습니다. 이 주소로 다시 읽지 말고 사용자에게 알리세요.`,
        { redirectTo: step.url },
      );
    case "loop":
      return new LinkReadError(`리다이렉트가 이미 거친 주소(${to})로 되돌아옵니다(리다이렉트 루프). 직접 열어 확인해 주세요.`, {
        redirectTo: step.url,
      });
    case "downgrade":
      return new LinkReadError(
        `이 링크는 https에서 암호화되지 않은 http 주소(${to})로 리다이렉트되어 따라가지 않았습니다. 직접 열어 확인해 주세요.`,
        { redirectTo: step.url },
      );
    case "too_many":
      return new LinkReadError(
        `리다이렉트가 ${MAX_LINK_REDIRECTS}번을 넘어 멈췄습니다(다음 목적지: ${to}). 직접 열어 확인해 주세요.`,
        { redirectTo: step.url },
      );
    default:
      return new LinkReadError(`이 링크는 읽을 수 없는 주소(${to})로 리다이렉트됩니다(${step.detail ?? "주소가 아님"}).`, {
        redirectTo: step.url,
      });
  }
}

// pageLink: 카드에 보였던 원래 링크(리다이렉트 목적지 후보면 그 목적지로 보낸 페이지 링크). 다른 사이트 목적지 기억에 쓴다.
async function fetchHtml(
  url: string,
  pageLink: string,
  memory: RedirectMemory,
  signal?: AbortSignal,
): Promise<{ html: string; finalUrl: string }> {
  // 리다이렉트를 따라가도 링크 하나에 쓰는 시간은 같은 한도 안이다.
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const start = requestUrl(url);
  if (!start) throw new LinkReadError("주소가 아닙니다.");
  const visited = [start];
  let current = start;
  let res: Response;
  for (;;) {
    // 쿠키를 싣지 않는다. 리다이렉트는 fetch가 따라가지 않게 하고(redirect: "error"), 목적지를 단계마다 다시 검사한 뒤
    // 같은 사이트 안이면 새 요청으로 받는다(카드에 보인 링크의 사이트 밖으로는 요청을 보내지 않는다).
    const target = current;
    const attempt = await oneAtATime(target, async () => {
      const redirect = watchRedirect(target);
      try {
        return { res: await fetch(target, { credentials: "omit", redirect: "error", signal: combined }), location: null };
      } catch {
        if (signal?.aborted || timeout.aborted) return { res: null, location: null };
        return { res: null, location: await redirect.settled() };
      } finally {
        redirect.stop();
      }
    });
    if (attempt.res) {
      res = attempt.res;
      break;
    }
    {
      if (signal?.aborted) throw new Error("사용자가 중단했습니다.");
      if (timeout.aborted) throw new LinkReadError(`${FETCH_TIMEOUT_MS / 1000}초 안에 받지 못했습니다.`);
      const location = attempt.location;
      if (!location) {
        debugLog("linked_pages:network", short(current), "warn");
        throw new LinkReadError("네트워크 오류로 받지 못했습니다(연결할 수 없거나 응답이 끊김). 직접 열어 확인해 주세요.");
      }
      const step = nextRedirectStep(url, location, visited);
      debugLog("linked_pages:redirect", `${short(current)} → ${short(location)} · ${step.kind === "follow" ? "follow" : step.reason}`);
      if (step.kind !== "follow") throw redirectStopError(step, memory, pageLink);
      visited.push(step.url);
      current = step.url;
    }
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    debugLog("linked_pages:status", `${short(current)} · HTTP ${res.status}`, "warn");
    if (blockedWithoutCookies(res.status)) {
      throw new LinkReadError(
        `HTTP ${res.status}: 이 사이트가 로그인 쿠키 없이 받는 요청을 막았습니다(로그인 필요·접근 거부·요청 제한일 수 있음). 이 링크가 꼭 필요하면 click_element를 거치지 말고 navigate_to_url로 ${short(url)} 을 한 번 열어 get_page_content로 읽으세요.`,
        { blocked: true },
      );
    }
    throw new LinkReadError(`HTTP ${res.status}로 받지 못했습니다.`);
  }
  const type = res.headers.get("content-type");
  if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(type ?? "")) {
    await res.body?.cancel().catch(() => {});
    throw new Error("웹 페이지(HTML)가 아닙니다. 파일이면 read_document를 쓰세요.");
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_HTML_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new Error("페이지가 너무 큽니다(2MB 초과).");
  }
  const reader = res.body?.getReader();
  if (!reader) return { html: decodeHtml(type, new Uint8Array(await res.arrayBuffer())), finalUrl: current };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HTML_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("페이지가 너무 큽니다(2MB 초과).");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { html: decodeHtml(type, bytes), finalUrl: current };
}

async function readOne(
  url: string,
  pageLink: string,
  memory: RedirectMemory,
  maxChars: number,
  signal?: AbortSignal,
): Promise<PageRead> {
  try {
    const { html, finalUrl } = await fetchHtml(url, pageLink, memory, signal);
    // 같은 사이트 안 리다이렉트를 따라갔으면 실제로 읽은 주소를 함께 알린다.
    const moved = finalUrl !== requestUrl(url) ? { finalUrl } : {};
    const job: HtmlExtractJob = { kind: "html_extract", html, maxChars };
    const r = await runOffscreenJob<HtmlExtractResult>(job, [], {
      signal,
      guardMs: EXTRACT_GUARD_MS,
      cancelled: { ok: false, kind: "cancelled" },
      timedOut: { ok: false, kind: "timeout" },
      closed: { ok: false, kind: "closed" },
    });
    if (!r.ok) {
      if (r.kind === "cancelled") throw new Error("사용자가 중단했습니다.");
      return { url, error: "본문을 추출하지 못했습니다." };
    }
    if (!r.text.trim()) {
      return {
        url,
        ...moved,
        error:
          "본문을 추출하지 못했습니다(자바스크립트로 그리는 페이지·로그인·오류 화면일 수 있음). 이 링크가 꼭 필요하면 click_element를 거치지 말고 navigate_to_url로 이 주소를 한 번 열어 get_page_content로 읽으세요.",
      };
    }
    return {
      url,
      ...moved,
      title: r.title,
      text: r.text,
      truncated: r.truncated,
      ...(r.text.length < SHORT_CHARS ? { short: true as const } : {}),
    };
  } catch (err) {
    if (signal?.aborted) throw new Error("사용자가 중단했습니다.");
    const msg = err instanceof Error ? err.message : String(err);
    debugLog("linked_pages:fail", msg, "warn");
    return { url, error: msg, ...(err instanceof LinkReadError ? err.extra : {}) };
  }
}

export async function readChosenLinks(callId: string, signal?: AbortSignal): Promise<PageRead[]> {
  const snap = snapshots.get(callId);
  const list = snap?.list ?? [];
  const ids = chosen.get(callId) ?? [];
  discardLinkCall(callId);
  const picked = ids.map((id) => list.find((c) => c.choiceId === id)).filter((c): c is Candidate => !!c);
  if (!snap || !picked.length) throw new Error("사용자가 읽을 링크를 고르지 않았습니다.");
  const memory = memoryFor(snap.turnTab);
  const urls = picked.map((c) => c.url);
  const perPage = Math.min(PER_PAGE_CHARS, Math.floor(TOTAL_CHARS / urls.length));
  const out: PageRead[] = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      out[i] = await readOne(urls[i], picked[i].pageLink ?? urls[i], memory, perPage, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  if (signal?.aborted) throw new Error("사용자가 중단했습니다.");
  return out;
}
