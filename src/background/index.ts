import { keepassxcAssociate, keepassxcForget, keepassxcStatus } from "./keepassxc";
import { PORT_NAME, SETTINGS_KEY, type BgToPanel, type PanelToBg, type Settings } from "@/lib/messages";
import { PARK_TTL_MS, ParkedConversations, prevDisconnectDetail, type PanelClose, type ResumeMissing } from "@/lib/panelLink";
import { normalizeSettings } from "@/lib/settings";
import { ChatAgent } from "./agent/chatAgent";
import { applyLoginSiteOp, applyManualSiteOp, applyRemoteSiteOp, applySettingsPatch, getSettings, invalidateSettingsCache, migrateLoginGrantIds } from "./storage";
import { parseLoginSiteOp, parseManualSiteOp, parseRemoteSiteOp } from "@/lib/settingsOps";
import { openSettings } from "./settingsTab";
import { deletePages, draftLink, listPages, rememberCurrentPage, rememberedFor, savePage, updateLink } from "./savedPagesStore";
import { panelTarget } from "./panelTarget";
import { handleHistoryPickPort, HISTORY_PICK_PORT } from "./historyPickStore";
import { VOICE_PORT, handleVoicePort } from "./voice";
import { addRule, checkSuggestionRun, deleteRule, listRules, updateRule } from "./pageSuggestStore";
import type { ParamChoice } from "@/lib/savedPages";
import { clearActionLog, pruneActionLog, storedCounts } from "./actionLog";
import { translateBatch } from "./translator";
import { checkConnection } from "./connectionCheck";
import { friendlyError } from "@/lib/friendlyError";
import { registerDebugSink, debugLog } from "./debug";
import { listLocalModels, setLocalNote } from "@/lib/providers/local";

// 로컬 서버 어댑터의 메모(뺀 선택 필드 등, #193)를 디버그 타임라인으로.
setLocalNote((tag, detail) => debugLog(tag, detail));
import {
  clearRepeatPlan,
  continueRepeatTask,
  deleteRepeatTask,
  makeRepeatPlan,
  listRepeatTasks,
  pauseRepeatTask,
  registerRepeatSink,
  resumeRepeatTask,
  runRepeatNow,
} from "./repeatTasks";
import { mcpRegenerate, mcpSecret, mcpSet, mcpStatus } from "./mcp";
import {
  telegramClear,
  telegramDisconnect,
  telegramSaveToken,
  telegramSetAskApproval,
  telegramSetNotify,
  telegramSetNotifySummary,
  telegramStartPairing,
  telegramStatus,
} from "./telegram";
import {
  clearGoogleToken,
  connectGoogle,
  getGoogleConnectionState,
} from "./google/auth";

// 저장소(API 키·텔레그램 봇 토큰 등)는 확장의 화면·서비스 워커만 읽게 한다(content script는 저장소를 쓰지 않는다, #139).
chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});

pruneActionLog();
// 옛 자동 로그인 항목에 승인 식별자(grantId)를 한 번 채운다(#127 — 설정 화면의 빼기·코드 변경이 그 값과 비교한다).
migrateLoginGrantIds().catch((err) => console.warn("[login grantId]", err));
// 하네스용: 워커를 다시 시작하지 않고 이전을 다시 부른다(이미 채운 값은 바꾸지 않는다).
(globalThis as { __sbpSettings?: unknown }).__sbpSettings = { migrateLoginGrantIds };

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn("[sidePanel.setPanelBehavior]", err));
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => {
      console.warn("[sidePanel.open]", err);
    });
  }
});

// 이 서비스 워커 실행의 식별자(시작마다 새 값)와 시작 시각(#243 진단 — 패널이 앞 연결과 비교해 워커가 다시 떴는지 안다).
const WORKER_RUN = { id: crypto.randomUUID().slice(0, 8), startedAt: Date.now() };
let panelConnectSeq = 0;
// 끊길 때 쉬고 있던 대화(같은 워커 안에서 60초, #243). 같은 패널이 다시 붙어 resume_conversation을 보내면 한 번 꺼내 이어 쓴다.
// 메모리에만 두고 저장하지 않는다. 만료·밀려나면 abort로 정리한다.
const parked = new ParkedConversations<ChatAgent>((a) => a.abort());
// 백그라운드가 본 마지막 패널 끊김(다음 연결 때 port:prev_disconnect로 남긴다).
let lastPanelClose: PanelClose | null = null;

// 확장 화면(패널)에서 연 연결인지(content script·웹 페이지의 연결은 sender.url이 웹 주소).
function fromExtensionPage(port: chrome.runtime.Port): boolean {
  return port.sender?.id === chrome.runtime.id && !!port.sender?.url?.startsWith(chrome.runtime.getURL(""));
}

// 지금 열린 패널 연결(하네스가 끊김을 만들 때 쓴다). close: onDisconnect와 같은 정리(연결마다 한 번).
const panelLinks = new Set<{ port: chrome.runtime.Port; close: () => void; agent: () => ChatAgent | null }>();
// 하네스용(기존 __sbpSettings와 같은 방식, 확장 맥락에서만 접근): 백그라운드 쪽에서 패널 연결을 끊는다. 자기 쪽 disconnect()는
// 자기 onDisconnect를 부르지 않으므로 정리(보관 포함)를 먼저 직접 부르고, forget이면 보관함을 비운 뒤 끊는다 — 패널의 재연결은 그
// 뒤에야 일어나므로 "끊김 정리 → 보관함 비우기 → 재연결" 순서가 보장된다.
(globalThis as { __sbpPorts?: unknown }).__sbpPorts = {
  dropPanelPorts(opts: { forget?: boolean } = {}): number {
    const links = [...panelLinks];
    for (const l of links) l.close();
    if (opts.forget) parked.clear();
    for (const l of links) {
      try {
        l.port.disconnect();
      } catch {
        /* already closed */
      }
    }
    return links.length;
  },
  parkedCount: (): number => parked.size,
  // 지금 연결의 대화를 "사용자가 디버깅을 취소함" 상태로(실제 막대 취소는 하네스에서 누를 수 없다) / 그 상태를 읽는다.
  cancelInput(): void {
    for (const l of panelLinks) l.agent()?.markInputCanceledForHarness();
  },
  inputCanceled: (): boolean[] => [...panelLinks].map((l) => l.agent()?.inputCanceled() ?? false),
};

chrome.runtime.onConnect.addListener((port) => {
  // 방문 기록에서 기억할 페이지 찾기(#175): 이 확장의 화면(설정)에서 연 연결만.
  if (port.name === HISTORY_PICK_PORT) {
    if (port.sender?.id === chrome.runtime.id && port.sender.url?.startsWith(chrome.runtime.getURL(""))) handleHistoryPickPort(port);
    else port.disconnect();
    return;
  }
  // 음성 입력(#184): 패널에서 연 연결만.
  if (port.name === VOICE_PORT) {
    if (port.sender?.id === chrome.runtime.id && port.sender.url?.startsWith(chrome.runtime.getURL(""))) handleVoicePort(port);
    else port.disconnect();
    return;
  }
  if (port.name !== PORT_NAME) return;

  let agent: ChatAgent | null = null;
  let activeConversationId: string | null = null;
  // 사용자의 대화 동작(요청·중단·새 대화·이어서 진행)마다 올린다. 이어서 진행의 준비를 기다리는 사이 이 값이 바뀌면
  // 그 준비는 버린다(사용자가 연 새 대화를 덮지 않게, #138).
  let actionSeq = 0;
  let disconnected = false;
  const connectedAt = Date.now();
  let lastHeartbeatAt: number | null = null;
  registerDebugSink(port);
  registerRepeatSink(port);
  panelConnectSeq += 1;
  debugLog("port:connect", `worker ${WORKER_RUN.id} · 가동 ${Math.round((connectedAt - WORKER_RUN.startedAt) / 1000)}초 · 이 워커의 ${panelConnectSeq}번째 연결`);
  debugLog("port:prev_disconnect", prevDisconnectDetail(lastPanelClose, connectedAt));
  try {
    port.postMessage({ kind: "port_hello", workerRun: WORKER_RUN.id, uptimeMs: connectedAt - WORKER_RUN.startedAt } satisfies BgToPanel);
  } catch {
    /* port closed */
  }

  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as PanelToBg;
    if (!msg || typeof msg !== "object") return;

    if (msg.kind === "user_msg" || msg.kind === "abort_stream" || msg.kind === "reset_conversation" || msg.kind === "repeat_continue" || msg.kind === "suggestion_run") actionSeq += 1;
    switch (msg.kind) {
      case "user_msg": {
        if (!agent || activeConversationId !== msg.conversationId) {
          agent?.abort();
          agent = new ChatAgent(port);
          activeConversationId = msg.conversationId;
        }
        agent.sendUserTurn(msg.text).catch((err) => {
          console.error("[sendUserTurn]", err);
        });
        return;
      }
      case "approve_tool":
        agent?.approveTool(
          msg.callId,
          msg.allowLinksThisTurn === true,
          Array.isArray(msg.choiceIds) ? msg.choiceIds.filter((x): x is string => typeof x === "string") : undefined,
          msg.allowToolThisChat === true,
          msg.allowUrlsThisChat === true,
          msg.rememberLoginSite === true,
        );
        return;
      case "revoke_chat_grant":
        agent?.revokeChatGrant(String(msg.tool));
        return;
      case "revoke_task":
        agent?.revokeTask();
        return;
      case "cancel_tool":
        agent?.cancelTool(msg.callId);
        return;
      case "abort_stream":
        agent?.abort();
        return;
      case "reset_conversation":
        agent?.abort();
        agent = new ChatAgent(port);
        activeConversationId = msg.conversationId;
        return;
      case "repeat_continue": {
        // 반복 작업의 "이어서 진행"(#138): 백그라운드가 한 번만 진행 상태로 바꾸고, 저장된 작업 내용으로 만든 요청을
        // 새 대화 객체로 그 작업의 탭에서 시작한다(패널이 보낸 글자는 쓰지 않는다).
        // 이 확장의 화면(패널)에서 연 연결만 받는다.
        if (!port.sender?.url?.startsWith(chrome.runtime.getURL(""))) return;
        const conversationId = String(msg.conversationId);
        const taskId = String(msg.taskId);
        const seq = actionSeq;
        // 기다리는 사이 다른 대화 동작이 있었거나 패널이 닫혔으면 시작하지 않는다(연 탭은 닫고 다시 누를 수 있게 되돌린다, #145).
        continueRepeatTask(taskId, {
          cancelled: () => seq !== actionSeq || disconnected,
          handOver: (text, tabId, site) => {
            // 패널에 알리지 못하면 던진다(탭을 닫고 되돌림).
            port.postMessage({ kind: "repeat_started", text });
            agent?.abort();
            agent = new ChatAgent(port);
            activeConversationId = conversationId;
            agent.sendUserTurn(text, { tabId, site }).catch((err) => console.error("[sendUserTurn]", err));
          },
        })
          .catch((err: unknown) => {
            // 그 사이 사용자가 다른 대화 동작을 했으면 알리지 않는다(새 대화의 화면 상태를 덮지 않게).
            if (seq !== actionSeq || disconnected) return;
            try {
              port.postMessage({ kind: "error", message: `반복 작업을 이어서 진행하지 못했습니다(${err instanceof Error ? err.message : String(err)}).` });
            } catch {
              /* port closed */
            }
          });
        return;
      }
      case "suggestion_run": {
        // 페이지 제안 실행(#173): 규칙·탭·문서를 다시 확인한 뒤 저장된 규칙의 요청으로 시작한다(패널이 보낸 글자는 쓰지 않는다).
        // 같은 대화면 대화 객체를 그대로 쓴다(외부 본문 보호 등 대화 상태 유지).
        if (!port.sender?.url?.startsWith(chrome.runtime.getURL(""))) return;
        const runId = String(msg.runId);
        const conversationId = String(msg.conversationId);
        const seq = actionSeq;
        checkSuggestionRun(msg)
          .then(({ rule, tabId, url, documentId }) => {
            if (seq !== actionSeq || disconnected) return;
            try {
              port.postMessage({ kind: "suggestion_started", runId, text: rule.request });
            } catch {
              return;
            }
            if (!agent || activeConversationId !== conversationId) {
              agent?.abort();
              agent = new ChatAgent(port);
              activeConversationId = conversationId;
            }
            agent.sendUserTurn(rule.request, { tabId, expect: { tabId, url, documentId } }).catch((err) => console.error("[sendUserTurn]", err));
          })
          .catch((err: unknown) => {
            if (seq !== actionSeq || disconnected) return;
            try {
              port.postMessage({ kind: "suggestion_failed", runId, message: err instanceof Error ? err.message : String(err) });
            } catch {
              /* port closed */
            }
          });
        return;
      }
      case "heartbeat":
        // panel liveness ping — keep the service worker from idling out
        lastHeartbeatAt = Date.now();
        return;
      case "resume_conversation": {
        // 다시 연결한 패널의 앞 대화 이어 쓰기(#243): 확장 화면 연결이고, 이 연결에 아직 대화가 없고, 같은 대화가 보관돼 있을 때만.
        const conversationId = String(msg.conversationId);
        const gen = Number(msg.gen);
        const reply = (resumed: boolean, reason?: ResumeMissing) => {
          debugLog(resumed ? "conversation:resumed" : "conversation:not_resumed", reason ?? "");
          try {
            port.postMessage({ kind: "conversation_resume", conversationId, gen, resumed, ...(reason ? { reason } : {}) } satisfies BgToPanel);
          } catch {
            /* port closed */
          }
        };
        if (!fromExtensionPage(port)) return reply(false, "sender");
        if (agent) return reply(false, "missing");
        const got = parked.take(conversationId, Date.now());
        if ("value" in got) {
          agent = got.value;
          activeConversationId = conversationId;
          agent.attachPort(port);
          return reply(true);
        }
        const busy = lastPanelClose?.conversationId === conversationId && lastPanelClose.busy;
        return reply(false, busy ? "busy" : got.missing);
      }
    }
  });

  // 설정이 바뀌면 지금 대화에 알린다(제공자·키·모델이 바뀌면 진행 중인 번역을 멈춘다).
  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && changes[SETTINGS_KEY]) agent?.onSettingsChanged(normalizeSettings(changes[SETTINGS_KEY].newValue as Partial<Settings> | undefined));
  };
  chrome.storage.onChanged.addListener(onStorage);

  // 연결이 끝났을 때의 정리(패널이 끊었거나 백그라운드가 끊음). 연결마다 한 번만.
  // 쉬고 있던 대화는 허용을 넓히는 상태를 지운 뒤 잠깐 보관하고(#243), 진행 중이던 대화는 지금처럼 멈추고 버린다.
  const link = {
    port,
    agent: () => agent,
    close: () => {
      if (disconnected) return;
      disconnected = true;
      panelLinks.delete(link);
      chrome.storage.onChanged.removeListener(onStorage);
      const now = Date.now();
      const busy = !!agent && !agent.idle();
      let kept = false;
      if (agent && !busy && activeConversationId) {
        agent.suspendForReconnect();
        parked.put(activeConversationId, agent, now);
        kept = true;
        setTimeout(() => parked.expire(Date.now()), PARK_TTL_MS + 1_000);
      } else agent?.abort();
      lastPanelClose = { at: now, connectedMs: now - connectedAt, heartbeatAt: lastHeartbeatAt, conversationId: activeConversationId, busy, parked: kept };
      agent = null;
      activeConversationId = null;
    },
  };
  panelLinks.add(link);
  port.onDisconnect.addListener(() => link.close());
});

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { kind?: string };

  // 저장한 페이지: 이 확장의 화면(패널·설정, 탭으로 연 경우 포함)에서만 받는다. content script가 보낸 메시지는
  // 발신 주소가 웹 페이지라 거절된다.
  if (
    m.kind === "save_page" ||
    m.kind === "saved_pages_list" ||
    m.kind === "saved_pages_delete" ||
    m.kind === "saved_link_draft" ||
    m.kind === "saved_link_update" ||
    m.kind === "remember_current_page" ||
    m.kind === "current_tab_info"
  ) {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "허용되지 않은 요청" });
      return false;
    }
    const p = msg as {
      offerId?: unknown;
      name?: unknown;
      purpose?: unknown;
      choices?: unknown;
      hints?: unknown;
      confirmedWarning?: unknown;
      optional?: unknown;
      id?: unknown;
      expectEvictId?: unknown;
      windowId?: unknown;
      tabId?: unknown;
      url?: unknown;
    };
    const job: Promise<unknown> =
      m.kind === "save_page"
        ? savePage({
            offerId: String(p.offerId ?? ""),
            name: String(p.name ?? ""),
            purpose: String(p.purpose ?? ""),
            choices: parseChoices(p.choices),
            hints: parseHints(p.hints),
            // 비워도 되는 자리 이름(문자열 배열만, #저장 링크 선택 자리).
            optional: Array.isArray(p.optional) ? p.optional.filter((k): k is string => typeof k === "string").slice(0, 20) : [],
            confirmedWarning: p.confirmedWarning === true,
            expectEvictId: typeof p.expectEvictId === "string" ? p.expectEvictId : null,
          })
        : m.kind === "remember_current_page"
          ? rememberCurrentPage(p.windowId, { tabId: p.tabId, url: p.url })
          : m.kind === "current_tab_info"
            ? // 패널 버튼 표시용(실행 때 다시 확인한다). 시크릿 창·활성 탭 없음이면 null. remembered: 이미 기억한 페이지(#191).
              panelTarget(p.windowId)
                .then(async (t) => ({ ...t, remembered: t.web ? await rememberedFor(t.url) : null }))
                .catch(() => null)
            : m.kind === "saved_link_draft"
              ? draftLink(String(p.offerId ?? ""))
              : m.kind === "saved_link_update"
                ? updateLink(String(p.id ?? ""), { name: p.name, purpose: p.purpose, hints: p.hints }).then(() => listPages())
                : m.kind === "saved_pages_delete"
                  ? deletePages(typeof p.id === "string" ? p.id : null).then(() => listPages())
                  : listPages();
    job
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  // 페이지 제안 규칙(#173): 이 확장의 화면에서만.
  if (m.kind === "page_suggest_list" || m.kind === "page_suggest_add" || m.kind === "page_suggest_update" || m.kind === "page_suggest_delete") {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "허용되지 않은 요청" });
      return false;
    }
    const p = msg as { id?: unknown; origin?: unknown; path?: unknown; label?: unknown; request?: unknown; enabled?: unknown; expectVersion?: unknown };
    const job =
      m.kind === "page_suggest_add"
        ? addRule(p)
        : m.kind === "page_suggest_update"
          ? updateRule(String(p.id ?? ""), { origin: p.origin, path: p.path, label: p.label, request: p.request, enabled: p.enabled, expectVersion: p.expectVersion })
          : m.kind === "page_suggest_delete"
            ? deleteRule(String(p.id ?? ""))
            : listRules();
    job
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (m.kind === "settings_patch") {
    // 이 확장의 화면(패널)에서만 받는다.
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "허용되지 않은 요청" });
      return false;
    }
    const patch = (msg as { patch?: unknown }).patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      sendResponse({ ok: false, error: "잘못된 설정" });
      return false;
    }
    applySettingsPatch(patch as Partial<Settings>)
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  // 직접 조작할 사이트·자동 로그인 목록의 항목 하나 바꾸기(#127). 이 확장의 화면에서만 받고, 값은 여기서 다시 검사한다.
  if (m.kind === "manual_site_op" || m.kind === "login_site_op" || m.kind === "remote_site_op") {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "허용되지 않은 요청" });
      return false;
    }
    const raw = (msg as { op?: unknown }).op;
    const job =
      m.kind === "manual_site_op"
        ? (() => {
            const op = parseManualSiteOp(raw);
            return op ? applyManualSiteOp(op) : Promise.reject(new Error("잘못된 사이트"));
          })()
        : m.kind === "remote_site_op"
          ? (() => {
              const op = parseRemoteSiteOp(raw);
              return op ? applyRemoteSiteOp(op) : Promise.reject(new Error("잘못된 사이트"));
            })()
        : (() => {
            const op = parseLoginSiteOp(raw);
            return op ? applyLoginSiteOp(op) : Promise.reject(new Error("잘못된 자동 로그인 항목"));
          })();
    job
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  // 설정 페이지 열기(#127). 이 확장의 화면(패널)에서만 받는다.
  if (m.kind === "open_settings") {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "허용되지 않은 요청" });
      return false;
    }
    const p = msg as { section?: unknown; windowId?: unknown };
    openSettings(p.section, p.windowId)
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  // 설정의 연결 확인(#129). 이 확장의 화면에서만 받는다.
  // 로컬 서버의 모델 목록(#193): 저장한 주소·키로 GET {주소}/models. 이 확장의 화면에서만 받는다.
  if (m.kind === "local_models") {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "허용되지 않은 요청" });
      return false;
    }
    void (async () => {
      const s = await getSettings();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const ids = await listLocalModels({ apiKey: s.apiKeys.local ?? "", baseUrl: s.localServer.baseUrl }, controller.signal);
        sendResponse({ ok: true, data: ids });
      } catch (err) {
        sendResponse({ ok: false, error: controller.signal.aborted ? "10초 안에 응답이 없습니다." : friendlyError(err).message });
      } finally {
        clearTimeout(timer);
      }
    })();
    return true;
  }

  if (m.kind === "check_connection") {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "허용되지 않은 요청" });
      return false;
    }
    checkConnection()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err: unknown) => {
        // 원문은 '자세히'로(#132). 키는 checkConnection이 이미 그 호출의 키로 가렸다.
        const f = friendlyError(err, { check: true });
        sendResponse({ ok: false, error: f.message, ...(f.detail ? { detail: f.detail } : {}) });
      });
    return true;
  }

  // 자동 로그인의 KeePassXC 연결(설정 화면). 이 확장의 화면에서만 받는다.
  if (m.kind === "keepassxc_status" || m.kind === "keepassxc_associate" || m.kind === "keepassxc_forget") {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "허용되지 않은 요청" });
      return false;
    }
    const job =
      m.kind === "keepassxc_associate"
        ? keepassxcAssociate()
        : m.kind === "keepassxc_forget"
          ? keepassxcForget().then(() => keepassxcStatus())
          : keepassxcStatus();
    job
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  // 반복 작업 관리(#138, 설정 화면). 이 확장의 화면에서만 받는다.
  if (
    m.kind === "repeat_list" ||
    m.kind === "repeat_pause" ||
    m.kind === "repeat_resume" ||
    m.kind === "repeat_delete" ||
    m.kind === "repeat_run_now" ||
    m.kind === "repeat_clear_plan" ||
    m.kind === "repeat_make_plan"
  ) {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "허용되지 않은 요청" });
      return false;
    }
    const id = String((msg as { id?: unknown }).id ?? "");
    const job =
      m.kind === "repeat_pause"
        ? pauseRepeatTask(id)
        : m.kind === "repeat_resume"
          ? resumeRepeatTask(id)
          : m.kind === "repeat_delete"
            ? deleteRepeatTask(id)
            : m.kind === "repeat_run_now"
              ? runRepeatNow(id)
              : m.kind === "repeat_clear_plan"
                ? clearRepeatPlan(id)
                : m.kind === "repeat_make_plan"
                  ? makeRepeatPlan(id)
                  : listRepeatTasks();
    job
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  // 텔레그램 연동(#139, 설정 화면). 이 확장의 화면에서만 받는다. 토큰은 돌려주지 않는다.
  if (
    m.kind === "telegram_status" ||
    m.kind === "telegram_save_token" ||
    m.kind === "telegram_pair" ||
    m.kind === "telegram_disconnect" ||
    m.kind === "telegram_clear" ||
    m.kind === "telegram_set_notify" ||
    m.kind === "telegram_set_notify_summary" ||
    m.kind === "telegram_set_ask"
  ) {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "허용되지 않은 요청" });
      return false;
    }
    const p = msg as { token?: unknown; on?: unknown };
    const job =
      m.kind === "telegram_save_token"
        ? telegramSaveToken(typeof p.token === "string" ? p.token : "")
        : m.kind === "telegram_pair"
          ? telegramStartPairing()
          : m.kind === "telegram_disconnect"
            ? telegramDisconnect()
            : m.kind === "telegram_clear"
              ? telegramClear()
              : m.kind === "telegram_set_notify"
                ? telegramSetNotify(p.on === true)
                : m.kind === "telegram_set_notify_summary"
                  ? telegramSetNotifySummary(p.on === true)
                  : m.kind === "telegram_set_ask"
                    ? telegramSetAskApproval(p.on === true)
                    : telegramStatus();
    job
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  // MCP 연동(#140, 설정 화면). 이 확장의 화면에서만 받는다. 비밀은 mcp_secret으로만 돌려준다(다리 설정에 넣어야 한다).
  if (m.kind === "mcp_status" || m.kind === "mcp_secret" || m.kind === "mcp_set" || m.kind === "mcp_regenerate") {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "허용되지 않은 요청" });
      return false;
    }
    const p = msg as { enabled?: unknown; port?: unknown; askApproval?: unknown; askViaTelegram?: unknown };
    const job: Promise<unknown> =
      m.kind === "mcp_secret"
        ? mcpSecret()
        : m.kind === "mcp_regenerate"
          ? mcpRegenerate()
          : m.kind === "mcp_set"
            ? mcpSet({
                ...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : {}),
                ...(typeof p.port === "number" ? { port: p.port } : {}),
                ...(typeof p.askViaTelegram === "boolean" ? { askViaTelegram: p.askViaTelegram } : {}),
                ...(typeof p.askApproval === "boolean" ? { askApproval: p.askApproval } : {}),
              })
            : mcpStatus();
    job
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (m.kind === "settings_updated") {
    invalidateSettingsCache();
    sendResponse({ ok: true });
    return true;
  }

  if (m.kind === "action_log_count" || m.kind === "action_log_clear") {
    (m.kind === "action_log_clear" ? clearActionLog().then(() => ({ log: 0, recipes: 0 })) : storedCounts())
      .then((count) => sendResponse({ ok: true, data: count }))
      .catch((err: unknown) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    return true;
  }

  if (m.kind === "google_connect") {
    debugLog("google:connect:received");
    // 클라이언트 ID 없이 빌드하면 identity 권한도 없다(정상) — 그때는 connectGoogle이 "직접 빌드 필요"를 알린다.
    const hasClientId = !!(chrome.runtime.getManifest() as { oauth2?: { client_id?: string } }).oauth2?.client_id;
    if (hasClientId && typeof chrome.identity === "undefined") {
      const msg =
        "chrome.identity API를 사용할 수 없습니다. 확장에 'identity' 권한이 적용되지 않았다는 뜻입니다. chrome://extensions 에서 이 확장을 '삭제' 후 다시 '압축해제된 확장 프로그램 로드'로 재설치해 주세요.";
      debugLog("google:connect:no_identity", msg, "error");
      sendResponse({ ok: false, error: msg });
      return true;
    }
    connectGoogle()
      .then(() => {
        debugLog("google:connect:ok");
        sendResponse({ ok: true });
      })
      .catch((err: unknown) => {
        const e = err instanceof Error ? err.message : String(err);
        debugLog("google:connect:error", e, "error");
        sendResponse({ ok: false, error: e });
      });
    return true;
  }

  if (m.kind === "google_disconnect") {
    clearGoogleToken()
      .then(() => {
        debugLog("google:disconnect:ok");
        sendResponse({ ok: true });
      })
      .catch((err: unknown) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (m.kind === "google_status") {
    getGoogleConnectionState()
      .then((state) => sendResponse({ ok: true, data: state }))
      .catch((err: unknown) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (m.kind === "google_diag") {
    (async () => {
      const mf = chrome.runtime.getManifest();
      const state = await getGoogleConnectionState();
      const hasIdentity = typeof chrome.identity !== "undefined";
      let redirectUrl = "";
      let identityCallError = "";
      if (hasIdentity) {
        try {
          redirectUrl = chrome.identity.getRedirectURL();
        } catch (err) {
          identityCallError = err instanceof Error ? err.message : String(err);
        }
      }
      const masked =
        state.clientId.length > 18
          ? state.clientId.slice(0, 8) + "…" + state.clientId.slice(-10)
          : state.clientId;
      const oauth2 = (mf as typeof mf & {
        oauth2?: { client_id?: string; scopes?: string[] };
      }).oauth2;
      return {
        extensionId: chrome.runtime.id,
        extensionVersion: mf.version,
        manifestPermissions: mf.permissions ?? [],
        hostPermissions: mf.host_permissions ?? [],
        manifestOauth2Present: !!oauth2,
        manifestOauth2Scopes: oauth2?.scopes ?? [],
        identityApiPresent: hasIdentity,
        identityApiError: identityCallError,
        redirectUrlFromIdentity: redirectUrl,
        googleClientIdConfigured: state.configured,
        googleClientIdPreview: masked || "(비어 있음)",
        googleTokenCached: state.connected,
        timestamp: new Date().toISOString(),
      };
    })()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err: unknown) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (m.kind === "translate_text_batch") {
    const payload = msg as { kind: "translate_text_batch"; texts: string[]; targetLang: string; session?: unknown };
    if (!Array.isArray(payload.texts) || typeof payload.targetLang !== "string") {
      sendResponse({ ok: false, error: "invalid payload" });
      return true;
    }
    // 세션 id가 없는 옛 형식(업데이트 직후 열려 있던 옛 content script)은 보내지 않는다(#193 — 대상을 고정할 수 없다).
    translateBatch(payload.texts, payload.targetLang, typeof payload.session === "string" ? payload.session : "")
      .then((translations) => sendResponse({ ok: true, data: translations }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        sendResponse({ ok: false, error: message });
      });
    return true; // keep channel open for async response
  }

  return false;
});

// 저장 카드의 쿼리 값 선택(패널에서 온 값이라 형태를 다시 본다).
function parseChoices(raw: unknown): ParamChoice[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c): ParamChoice => {
    const x = c as { mode?: unknown; slot?: unknown };
    if (x?.mode === "drop") return { mode: "drop" };
    if (x?.mode === "slot") return { mode: "slot", slot: typeof x.slot === "string" ? x.slot : "" };
    return { mode: "keep" };
  });
}

function parseHints(raw: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}
