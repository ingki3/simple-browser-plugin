import { httpOrigin } from "./url.ts";
// "직접 조작할 사이트"(0.2.2): 사용자가 고른 사이트에서는 도우미가 클릭·입력을 하지 않고, 대상을 화면에 표시해 사용자가
// 직접 하게 한다(손 넘기기). 자동 조작을 막는 사이트(예매 등)를 존중하는 방법이다. 사이트는 사용자의 명시적 선택으로만
// 정하고(주소의 출처), 페이지 글자로 짐작해 넣지 않는다.

export const MAX_MANUAL_SITES = 50;

// 사이트 키: http(s) 주소의 출처(scheme://host[:port]). 웹 주소가 아니면 null.
export function manualSiteOf(url: string | undefined): string | null {
  return httpOrigin(url);
}

// 저장된 값 정리: 출처 형태의 문자열만, 중복 없이, 최대 MAX_MANUAL_SITES개.
export function normalizeManualSites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const site = manualSiteOf(v);
    if (!site || site !== v || out.includes(site)) continue;
    out.push(site);
    if (out.length >= MAX_MANUAL_SITES) break;
  }
  return out;
}

export function isManualSite(sites: readonly string[], url: string | undefined): boolean {
  const site = manualSiteOf(url);
  return !!site && sites.includes(site);
}

// 손 넘기기를 마친 방법. clicked: 표시한 대상을 사용자가 실제로 누름. confirmed: 사용자가 패널에서 "했어요"를 누름.
// page_changed: 기다리는 사이 문서가 바뀜(사용자가 이동했거나 페이지가 다시 그려짐).
export type HandoffOutcome = "clicked" | "confirmed" | "page_changed";

// 패널 결과 줄에 붙이는 짧은 설명.
export const HANDOFF_LABELS: Record<HandoffOutcome, string> = {
  clicked: "표시한 대상을 사용자가 직접 누름",
  confirmed: "사용자가 직접 했다고 알림",
  page_changed: "사용자가 조작하는 사이 페이지가 바뀜",
};

// 모델에 돌려주는 결과 문구. 사용자가 입력한 값은 담지 않는다(#43).
export function handoffResultText(tool: "click_element" | "fill_form_fields", outcome: HandoffOutcome): string {
  const what = tool === "click_element" ? "누르기를" : "입력을";
  const how =
    outcome === "clicked"
      ? "사용자가 표시한 대상을 직접 눌렀습니다"
      : outcome === "page_changed"
        ? "사용자가 직접 조작하는 사이 페이지가 바뀌었습니다"
        : `사용자가 직접 ${what} 마쳤다고 알렸습니다`;
  return `${how}(이 사이트는 사용자가 '직접 조작할 사이트'로 정해 도우미가 대신 ${what} 하지 않습니다). 결과는 페이지를 다시 관측해 확인하세요.`;
}

// 설정 페이지(#127)의 "열린 탭에서 고르기": 열린 탭의 주소에서 사이트(출처) 후보를 만든다. 웹 주소가 아닌 탭·이미 넣은 사이트·
// 중복은 빼고, 사이트마다 처음 만난 탭의 제목(60자)을 함께 보인다(사용자 화면 표시용 — 모델로 보내지 않음).
export function tabSiteChoices(
  tabs: ReadonlyArray<{ url?: string; title?: string }>,
  existing: readonly string[],
): { site: string; title: string }[] {
  const out: { site: string; title: string }[] = [];
  for (const t of tabs) {
    const site = manualSiteOf(t.url);
    if (!site || existing.includes(site) || out.some((c) => c.site === site)) continue;
    out.push({ site, title: (t.title ?? "").trim().slice(0, 60) });
  }
  return out;
}
