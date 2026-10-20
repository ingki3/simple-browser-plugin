import type { ContentResponse } from "@/lib/messages";
import type { HtmlExtractJob, HtmlExtractResult } from "@/lib/documentJob";
import { decodeHtml } from "@/lib/htmlCharset";
import { sensitiveUrlReason } from "@/lib/autoApprove";
import { siteOf, withinSite } from "@/lib/siteTrust";
import { resolveTurnTab, type TurnTab } from "./tools/handlers";
import { runOffscreenJob } from "./offscreen";
import { debugLog } from "./debug";

// read_linked_pages: 지금 페이지에 실제로 있는 링크만, 쿠키 없이 받아 와 본문을 읽는다(탭 이동 없음).
// 카드를 띄우기 전에 후보(id·주소)를 고정하고, 사용자가 고른 id의 주소만 받아 온다.

const PER_PAGE_CHARS = 4_000;
const TOTAL_CHARS = 24_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const EXTRACT_GUARD_MS = 15_000;
const CONCURRENCY = 4;
const SHORT_CHARS = 200;
const MAX_SNAPSHOTS = 20;

interface Candidate {
  choiceId: string;
  url: string;
  text: string;
}

export interface LinkChoice {
  id: string;
  label: string;
  sub: string;
}

const snapshots = new Map<string, Candidate[]>();
const chosen = new Map<string, string[]>();

// 구조적으로 읽지 않는 주소: http(s)가 아니거나 계정 정보가 실린 주소.
function structuralReject(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "주소가 아님";
  }
  if (!/^https?:$/.test(u.protocol)) return "웹 주소가 아님";
  if (u.username || u.password) return "계정 정보가 실린 주소";
  return null;
}

export async function snapshotLinks(
  callId: string,
  turnTab: TurnTab,
  urls: string[],
): Promise<{ choices: LinkChoice[]; defaults: string[]; rejected: string[] }> {
  const tabId = await resolveTurnTab(turnTab);
  const pageUrl = (await chrome.tabs.get(tabId)).url ?? "";
  const res = (await chrome.tabs.sendMessage(tabId, { kind: "link_lookup", urls }, { frameId: 0 })) as ContentResponse<
    Array<{ url: string; present: boolean; text: string }>
  >;
  if (!res?.ok || !res.data) throw new Error(res?.error ?? "페이지의 링크를 확인하지 못했습니다.");
  const list: Candidate[] = [];
  const choices: LinkChoice[] = [];
  const defaults: string[] = [];
  const rejected: string[] = [];
  const pageSite = siteOf(pageUrl);
  for (const item of res.data) {
    const reject = item.present ? structuralReject(item.url) : "지금 페이지에 없는 링크";
    if (reject) {
      rejected.push(`${item.url.slice(0, 120)} (${reject})`);
      continue;
    }
    const choiceId = crypto.randomUUID();
    list.push({ choiceId, url: item.url, text: item.text });
    // 결제·개인정보 신호(키워드 포함)는 경고와 기본 미선택(더 묻기)으로만 쓴다.
    const warn = sensitiveUrlReason(item.url);
    const other = pageSite && !withinSite(pageSite, item.url) ? "다른 사이트" : "";
    const notes = [warn ? `⚠ ${warn} — 열기만 해도 동작하는 링크일 수 있음` : "", other].filter(Boolean).join(" · ");
    choices.push({ id: choiceId, label: item.text || item.url, sub: notes ? `${item.url} (${notes})` : item.url });
    if (!warn) defaults.push(choiceId);
  }
  if (!list.length) throw new Error(`읽을 수 있는 링크가 없습니다: ${rejected.join(", ")}`);
  snapshots.set(callId, list);
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
  return { choices, defaults, rejected };
}

export function setChosenLinks(callId: string, ids: string[]): void {
  const known = new Set((snapshots.get(callId) ?? []).map((c) => c.choiceId));
  chosen.set(callId, [...new Set(ids)].filter((id) => known.has(id)));
}

export function discardLinkCall(callId: string): void {
  snapshots.delete(callId);
  chosen.delete(callId);
}

type PageRead =
  | { url: string; title: string; text: string; truncated: boolean; short?: true }
  | { url: string; error: string };

async function fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    // 쿠키를 싣지 않고, 리다이렉트는 따라가지 않는다(목적지를 다음 요청 대상으로 쓰지 않음).
    res = await fetch(url, { credentials: "omit", redirect: "error", signal: combined });
  } catch (err) {
    if (signal?.aborted) throw new Error("사용자가 중단했습니다.");
    if (timeout.aborted) throw new Error(`${FETCH_TIMEOUT_MS / 1000}초 안에 받지 못했습니다.`);
    throw new Error("받지 못했습니다(다른 주소로 리다이렉트되는 링크이거나 네트워크 오류). 직접 열어 확인해 주세요.");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
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
  if (!reader) return decodeHtml(type, new Uint8Array(await res.arrayBuffer()));
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
  return decodeHtml(type, bytes);
}

async function readOne(url: string, maxChars: number, signal?: AbortSignal): Promise<PageRead> {
  try {
    const html = await fetchHtml(url, signal);
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
        error: "본문을 추출하지 못했습니다(자바스크립트로 그리는 페이지·로그인·오류 화면일 수 있음). 직접 열어 확인해 주세요.",
      };
    }
    return {
      url,
      title: r.title,
      text: r.text,
      truncated: r.truncated,
      ...(r.text.length < SHORT_CHARS ? { short: true as const } : {}),
    };
  } catch (err) {
    if (signal?.aborted) throw new Error("사용자가 중단했습니다.");
    const msg = err instanceof Error ? err.message : String(err);
    debugLog("linked_pages:fail", msg, "warn");
    return { url, error: msg };
  }
}

export async function readChosenLinks(callId: string, signal?: AbortSignal): Promise<PageRead[]> {
  const list = snapshots.get(callId) ?? [];
  const ids = chosen.get(callId) ?? [];
  discardLinkCall(callId);
  const urls = ids.map((id) => list.find((c) => c.choiceId === id)?.url).filter((u): u is string => !!u);
  if (!urls.length) throw new Error("사용자가 읽을 링크를 고르지 않았습니다.");
  const perPage = Math.min(PER_PAGE_CHARS, Math.floor(TOTAL_CHARS / urls.length));
  const out: PageRead[] = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      out[i] = await readOne(urls[i], perPage, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  if (signal?.aborted) throw new Error("사용자가 중단했습니다.");
  return out;
}
