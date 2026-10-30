// 주소 기반 동작 제안(#173) 규칙 저장소와 실행 확인. 규칙은 사용자가 만든 것만 있고, 실행은 사용자가 칩을 누를 때만 한다.
// 실행 직전에 규칙(전역 설정·켜짐·버전)과 패널 창의 활성 탭(탭·주소·문서)을 다시 확인한다.
import { MAX_RULES, matchesRule, normalizeRuleInput, parseRules, type SuggestionRule } from "@/lib/pageSuggest";
import { containsSecret } from "./loginSecrets";
import { getSettings } from "./storage";
import { enqueue } from "./actionLog";
import { panelTarget } from "./panelTarget";
import { topDocumentId } from "./tools/handlers";

export const PAGE_SUGGESTIONS_KEY = "pageSuggestions";

async function load(): Promise<SuggestionRule[]> {
  const obj = await chrome.storage.local.get(PAGE_SUGGESTIONS_KEY);
  return parseRules(obj[PAGE_SUGGESTIONS_KEY]);
}

async function store(list: SuggestionRule[]): Promise<void> {
  await chrome.storage.local.set({ [PAGE_SUGGESTIONS_KEY]: list });
}

export async function listRules(): Promise<SuggestionRule[]> {
  return load();
}

// 새 규칙(말풍선의 "이 페이지에서 제안" 또는 설정에서 직접 추가).
export async function addRule(input: { origin?: unknown; path?: unknown; label?: unknown; request?: unknown }): Promise<SuggestionRule[]> {
  const n = normalizeRuleInput(input);
  // 요청·문구에 자동 로그인으로 넣은 값이 있으면 저장하지 않는다(나중에 모델로 보내는 글자가 된다).
  if (await containsSecret(n)) throw new Error("자동 로그인으로 넣은 값이 들어 있어 저장하지 않았습니다.");
  return enqueue(async () => {
    const list = await load();
    if (list.length >= MAX_RULES) throw new Error(`제안은 ${MAX_RULES}개까지 둘 수 있습니다. 쓰지 않는 제안을 지워 주세요.`);
    const rule: SuggestionRule = { id: crypto.randomUUID(), ...n, enabled: true, version: 1, createdAt: Date.now() };
    const next = [...list, rule];
    await store(next);
    return next;
  });
}

// 고치기·켜기·끄기. 내용이나 켜짐이 바뀌면 버전을 올린다(이미 떠 있는 칩은 실행 때 거절되고 다시 읽는다).
export async function updateRule(
  id: string,
  patch: { origin?: unknown; path?: unknown; label?: unknown; request?: unknown; enabled?: unknown },
): Promise<SuggestionRule[]> {
  const content = patch.origin !== undefined || patch.path !== undefined || patch.label !== undefined || patch.request !== undefined;
  return enqueue(async () => {
    const list = await load();
    const hit = list.find((r) => r.id === id);
    if (!hit) throw new Error("제안을 찾을 수 없습니다.");
    if (content) {
      const n = normalizeRuleInput({
        origin: patch.origin ?? hit.origin,
        path: patch.path ?? hit.path,
        label: patch.label ?? hit.label,
        request: patch.request ?? hit.request,
      });
      if (await containsSecret(n)) throw new Error("자동 로그인으로 넣은 값이 들어 있어 저장하지 않았습니다.");
      Object.assign(hit, n);
    }
    if (typeof patch.enabled === "boolean") hit.enabled = patch.enabled;
    hit.version += 1;
    await store(list);
    return list;
  });
}

export async function deleteRule(id: string): Promise<SuggestionRule[]> {
  return enqueue(async () => {
    const next = (await load()).filter((r) => r.id !== id);
    await store(next);
    return next;
  });
}

export interface SuggestionTarget {
  rule: SuggestionRule;
  tabId: number;
  url: string;
  documentId: string;
}

// 칩의 [실행]: 패널이 보낸 규칙·버전·탭·주소가 지금도 그대로인지 확인한다. 통과하면 보낼 요청은 저장된 규칙의 글자다.
export async function checkSuggestionRun(m: { windowId?: unknown; ruleId?: unknown; ruleVersion?: unknown; tabId?: unknown; url?: unknown }): Promise<SuggestionTarget> {
  const ruleNow = async () => {
    if (!(await getSettings()).pageSuggestions) throw new Error("설정에서 '페이지 제안'이 꺼져 있습니다.");
    const rule = (await load()).find((r) => r.id === m.ruleId);
    if (!rule || !rule.enabled) throw new Error("제안이 꺼졌거나 지워졌습니다.");
    if (rule.version !== m.ruleVersion) throw new Error("제안이 바뀌었습니다. 새 제안을 확인한 뒤 다시 누르세요.");
    return rule;
  };
  const rule = await ruleNow();
  const target = await panelTarget(m.windowId);
  if (target.tabId !== m.tabId || target.url !== m.url) throw new Error("페이지가 바뀌었습니다. 지금 페이지의 제안을 확인한 뒤 다시 누르세요.");
  if (!matchesRule(rule, target.url)) throw new Error("이 페이지는 제안과 맞지 않습니다.");
  const documentId = await topDocumentId(target.tabId);
  if (!documentId) throw new Error("페이지를 확인하지 못했습니다. 다시 누르세요.");
  // 탭·문서를 확인하는 사이 규칙·설정이 바뀌지 않았는지 한 번 더.
  const again = await ruleNow();
  if (again.request !== rule.request) throw new Error("제안이 바뀌었습니다. 새 제안을 확인한 뒤 다시 누르세요.");
  return { rule: again, tabId: target.tabId, url: target.url, documentId };
}
