// agent/tabContext.ts 단위 시험용 ../tools/handlers 대역(#263 단계 2). handlers.ts는 TS 매개변수 속성을 써서 Node 타입 제거로
// 불러올 수 없다. tabContext가 쓰는 두 함수만, 실제와 같은 모양(오류 턴 탭은 null, 따라가는 팝업 중 맨 위 → 그 탭)으로 흉내 내고
// 불린 순서를 globalThis.__tabEvents에 남긴다. 실제 currentToolTab처럼 첫 줄 뒤 한 번 기다린다(pruneClosedPopups).
const log = (e) => (globalThis.__tabEvents ??= []).push(e);

export async function currentToolTab(turnTab) {
  log(`currentToolTab(${"error" in turnTab ? "error" : turnTab.tabId})`);
  if ("error" in turnTab) return null;
  await null;
  const top = turnTab.popups?.[turnTab.popups.length - 1];
  return top ? { tabId: top.tabId, popup: true, ...(top.kind === "tab" ? { asTab: true } : {}) } : { tabId: turnTab.tabId, popup: false };
}

export async function topDocumentId(tabId) {
  log(`topDocumentId(${tabId})`);
  return `doc-${tabId}`;
}
