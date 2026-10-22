// "이번 대화 동안 이 도구 묻지 않기"(#53)의 판정. DOM·chrome API 없이 계산하는 부분만 둔다.
// 허락은 백그라운드의 대화 객체(ChatAgent) 메모리에만 두고 저장소에 남기지 않는다. 새 대화·패널 닫힘·확장이나
// 서비스 워커 재시작이면 대화 객체가 새로 만들어져 함께 사라진다.
//
// 대상은 도구 이름(구조)으로만 정한다. 호출 하나가 허락으로 덮이는지는 그 호출의 구조적 사실(주소가 지금 페이지에
// 있는지, 다른 사이트인지, 저장 폴더)과, 더 묻는 쪽으로만 쓰는 결제·개인정보 주소 신호(sensitiveUrlReason)로 본다.

import type { ToolName } from "./messages.ts";
import { sensitiveUrlReason } from "./autoApprove.ts";
import { DEFAULT_DOWNLOAD_FOLDER, sanitizeFilenameSegment } from "./sanitize.ts";

export type ChatGrantTool = "read_linked_pages" | "translate_page" | "download_images";

// usableWhileProtected: 외부 본문 보호(#37)가 켜진 대화에서도 허락을 쓰는지. 모델이 만든 값을 밖으로 내보낼 수 있는
// 도구(외부 전송 도구)는 보호 중에 허락을 쓰지 않는다(파일·외부 페이지에 숨긴 지시문이 허락을 타고 실행되지 않게).
const CHAT_GRANT_POLICY: Record<ChatGrantTool, { usableWhileProtected: boolean }> = {
  // 주소는 지금 페이지의 a[href]에 그대로 있는 것만(모델이 만든 주소 거절), 쿠키 없이 GET으로 받는다. 모델이 고를 수
  // 있는 것은 페이지가 준 링크 중 어느 것인지뿐이라 모델 유래 값을 실어 보내지 못한다. 이 도구 자체가 보호를 켜므로
  // 보호 중에 허락을 막으면 첫 호출 뒤로는 허락이 쓰이지 않는다. 숨긴 지시문이 같은 링크를 고르게 하는 것은 보호를 켜지
  // 않는 지금 페이지의 글로도 할 수 있어 보호가 더 막아 주는 것이 없다.
  read_linked_pages: { usableWhileProtected: true },
  // 모델이 고른 번역 언어와 페이지 글을 번역 서비스로 보내고 결과를 페이지에 쓴다(보호가 막는 "번역 언어" 경로).
  translate_page: { usableWhileProtected: false },
  // 모델이 고른 주소로 요청한다(쿼리에 대화 내용을 실을 수 있다).
  download_images: { usableWhileProtected: false },
};

export const CHAT_GRANT_TOOLS: readonly ChatGrantTool[] = Object.keys(CHAT_GRANT_POLICY) as ChatGrantTool[];

export function isChatGrantTool(tool: string): tool is ChatGrantTool {
  return Object.prototype.hasOwnProperty.call(CHAT_GRANT_POLICY, tool);
}

// 허락 범위(scope): 같은 도구라도 범위가 같을 때만 덮는다. download_images는 저장 폴더 접두사, 그 밖은 "".
export type ChatGrants = ReadonlyMap<ChatGrantTool, string>;

export interface ChatGrantCall {
  tool: ToolName;
  // 외부 본문 보호 중이라 이 도구에 승인이 필요한 상태인지(needsApprovalWhenProtected).
  protected: boolean;
  // 이 호출을 허락으로 덮지 못하는 구조적 이유(경고 링크 섞임, 페이지에 없는 이미지 등). 없으면 null.
  block: string | null;
  scope: string;
}

export interface ChatGrantDecision {
  // 허락으로 카드 없이 실행한다.
  covered: boolean;
  // 카드에 "승인 + 이번 대화 동안 이 도구 묻지 않기"를 함께 보인다.
  offer: boolean;
  // 이 도구를 허락했지만 이 호출은 덮지 못한 이유(카드에 붙인다). 허락이 없으면 null.
  reason: string | null;
}

// 이 호출이 허락으로 덮일 수 있는 모양인지. 덮일 수 없으면 그 이유.
function shapeBlock(call: ChatGrantCall): string | null {
  if (!isChatGrantTool(call.tool)) return "이번 대화 허락 대상이 아닌 도구";
  if (call.protected && !CHAT_GRANT_POLICY[call.tool].usableWhileProtected) return "외부 문서 내용을 읽은 대화";
  return call.block;
}

export function chatGrantDecision(grants: ChatGrants, call: ChatGrantCall): ChatGrantDecision {
  const why = shapeBlock(call);
  if (!isChatGrantTool(call.tool)) return { covered: false, offer: false, reason: null };
  const held = grants.get(call.tool);
  if (why) return { covered: false, offer: false, reason: held === undefined ? null : why };
  if (held === undefined) return { covered: false, offer: true, reason: null };
  if (held === call.scope) return { covered: true, offer: false, reason: null };
  // 범위가 다르면(다른 저장 폴더) 묻고, 이 범위로 바꿔 허락할 수 있게 제안한다.
  return { covered: false, offer: true, reason: `허락한 범위('${held}')와 다름` };
}

// read_linked_pages 후보 하나의 구조적 사실(linkedPages.snapshotLinks가 만든다).
export interface LinkFacts {
  url: string;
  // 지금 페이지와 다른 사이트(등록 도메인)의 링크.
  otherSite: boolean;
  // 페이지 링크가 다른 사이트로 리다이렉트한 목적지(페이지에 그대로 있지 않은 주소).
  redirected: boolean;
}

// 링크 읽기 호출을 허락으로 덮지 못하는 이유. 지금 카드에 경고가 붙는 링크(결제·개인정보 주소 신호, 다른 사이트,
// 리다이렉트 목적지)나 페이지에 없어 거절한 주소가 하나라도 섞이면 카드로 묻는다.
export function linkReadGrantBlock(links: readonly LinkFacts[], rejected: number): string | null {
  if (rejected > 0) return "지금 페이지에 없는 주소가 섞임";
  for (const l of links) {
    const why = sensitiveUrlReason(l.url);
    if (why) return `${why}가 섞임`;
    if (l.redirected) return "리다이렉트 목적지가 섞임";
    if (l.otherSite) return "다른 사이트 링크가 섞임";
  }
  return null;
}

// 이미지 저장 호출을 허락으로 덮지 못하는 이유. 지금 페이지의 이미지(list_page_images가 돌려주는 주소) 그대로가
// 아니거나 결제·개인정보 주소 신호가 있으면 묻는다. 모델이 만든 주소로는 허락을 타고 요청하지 않는다.
export function imageSaveGrantBlock(urls: readonly string[], pageImages: ReadonlySet<string>): string | null {
  if (!urls.length) return "저장할 이미지 없음";
  for (const u of urls) {
    if (!pageImages.has(u)) return "지금 페이지에 없는 이미지 주소가 섞임";
    const why = sensitiveUrlReason(u);
    if (why) return `${why}가 섞임`;
  }
  return null;
}

// 저장 폴더 범위: 실제로 저장하는 폴더 이름(startImageDownloads와 같은 정리). 이름이 달라도 같은 폴더로 정리되면 같다.
export function downloadScope(folder: string): string {
  return sanitizeFilenameSegment(folder || DEFAULT_DOWNLOAD_FOLDER);
}

// 허락으로 카드 없이 저장할 때는 브라우저 다운로드(그 호스트의 쿠키를 싣고 리다이렉트를 따라간다)를 쓰지 않고,
// 쿠키 없이·리다이렉트 없이 직접 받은 이미지 바이트만 저장한다. 그 상한과 응답 판정.
export const GRANT_IMAGE_LIMITS = {
  // 한 번에 받을 수 있는 이미지 수. 넘으면 카드로 묻는다(카드로 승인하면 기존 다운로드 경로).
  maxCount: 30,
  // 이미지 하나·전체 바이트 상한.
  maxBytes: 10 * 1024 * 1024,
  maxTotalBytes: 40 * 1024 * 1024,
} as const;

// 이미지 저장에서 무엇을 내려받을지(주소 → 실제로 넘길 출처). 허락 경로(viaGrant, 실행하는 쪽이 명시)면 그 호출을 위해
// 쿠키 없이 미리 받은 바이트(data: 주소)만 쓰고, 하나라도 없으면 원본 주소로 바꾸지 않고 실패한다(fail-closed).
// 카드로 승인한 일반 경로는 원본 주소 그대로(브라우저 다운로드).
export function imageDownloadSources(
  urls: readonly string[],
  viaGrant: boolean,
  prepared: ReadonlyMap<string, string> | null | undefined,
): Array<{ url: string; source: string }> | { error: string } {
  if (!viaGrant) return urls.map((url) => ({ url, source: url }));
  if (!prepared) return { error: "이번 대화 허락으로 저장할 이미지를 미리 받지 못했습니다." };
  const out: Array<{ url: string; source: string }> = [];
  for (const url of urls) {
    const source = prepared.get(url);
    if (!source || !source.startsWith("data:")) return { error: "이번 대화 허락으로 저장할 이미지를 미리 받지 못했습니다." };
    out.push({ url, source });
  }
  return out;
}

export function grantImageCountBlock(count: number): string | null {
  return count > GRANT_IMAGE_LIMITS.maxCount ? `이미지가 ${GRANT_IMAGE_LIMITS.maxCount}개보다 많음` : null;
}

// 쿠키 없이 받은 응답이 허락으로 저장해도 되는 이미지인지. 리다이렉트(3xx·따라간 응답)는 목적지를 검증하지 않으므로
// 받지 않는다. 이미지 Content-Type이 아니면 저장하지 않는다. bytes를 아직 모르면 null(Content-Length 없음).
export function grantImageResponseBlock(r: {
  status: number;
  redirected: boolean;
  contentType: string;
  bytes: number | null;
}): string | null {
  if (r.redirected || (r.status >= 300 && r.status < 400)) return "리다이렉트하는 이미지 주소";
  if (r.status < 200 || r.status >= 300) return `이미지 응답 오류(HTTP ${r.status})`;
  if (!/^image\//i.test(r.contentType.trim())) return "이미지가 아닌 응답";
  if (r.bytes !== null && r.bytes > GRANT_IMAGE_LIMITS.maxBytes) return "너무 큰 이미지";
  return null;
}
