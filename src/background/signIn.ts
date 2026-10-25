// sign_in 도구(자동 로그인, docs/design/login-automation.md)의 백그라운드 쪽.
// 1) prepareSignIn: 칸 둘레의 로그인 양식을 페이지에서 구조로 읽고(login_inspect), 브라우저가 정한 탭 주소로 출처를 확인한 뒤
//    KeePassXC에서 그 주소의 항목을 받는다. 승인 판정(자동·카드·손 넘기기)은 부르는 쪽(openrouter.ts)이 signInDecision으로 한다.
// 2) runSignIn: 고른 항목의 값을 가림 목록에 먼저 넣고, 같은 문서에 값을 넣고 제출한다(login_fill).
// 값은 이 호출의 메모리에만 두고 결과·오류·로그에 싣지 않는다.
import type { KpxEntry } from "@/lib/keepassxc";
import { loginOrigin, loginShapeBlock, type LoginShape } from "@/lib/loginPolicy";
import { debugLog } from "./debug";
import { keepassxcLogins, keepassxcTotp } from "./keepassxc";
import { rememberSecrets } from "./loginSecrets";
import { MIN_SECRET_LENGTH } from "@/lib/secretMask";
import { waitForNavigationSettle } from "./navigation";
import { recheckTabPopup, resolveTurnTab, topDocumentId, type TurnTab } from "./tools/handlers";
import { sendTo } from "./trustedInput";

interface SignInCall {
  tabId: number;
  documentId: string;
  origin: string | null;
  shape: LoginShape;
  // null: 비밀번호 관리자가 연결되지 않음. 오류는 kpxError.
  entries: KpxEntry[] | null;
  kpxError: string | null;
  // 카드에서 고른 항목.
  chosen: string | null;
}

const calls = new Map<string, SignInCall>();
const CALL_TTL_MS = 15 * 60_000;

export interface SignInPreview {
  // 이 준비의 상태 열쇠(승인·실행이 같은 준비를 쓰게).
  token: string;
  origin: string | null;
  shape: LoginShape;
  // 비밀번호 관리자 상태: none(연결 안 함)·error·ok.
  manager: "none" | "error" | "ok";
  managerError: string | null;
  // 카드에 보일 항목(이름과 아이디 — 패널에만 보이고 모델에는 가지 않는다).
  entries: Array<{ uuid: string; name: string; login: string }>;
}

const STEP_LABEL: Record<LoginShape["step"], string> = {
  password: "아이디·비밀번호",
  username: "아이디",
  otp: "일회용 코드",
};

export function stepLabel(step: LoginShape["step"]): string {
  return STEP_LABEL[step];
}

// callId는 모델이 정한 값이라 다른 대화와 겹칠 수 있다. 상태는 여기서 만든 token으로만 찾고, 페이지 쪽 승인 대상도 token으로 남긴다.
export async function prepareSignIn(id: string, _callId: string, turnTab: TurnTab): Promise<SignInPreview> {
  const token = crypto.randomUUID();
  const tabId = await resolveTurnTab(turnTab);
  await waitForNavigationSettle(tabId, 10_000);
  await recheckTabPopup(turnTab, tabId);
  const documentId = await topDocumentId(tabId);
  if (!documentId) throw new Error("탭의 문서를 확인할 수 없습니다. 다시 관측하세요.");
  const shape = await sendTo<LoginShape>(tabId, documentId, { kind: "login_inspect", id, callId: token }, 5_000, "로그인 칸 확인");
  // 출처는 브라우저가 아는 그 문서의 주소로 정한다(페이지가 알려 준 주소는 같은지 확인에만 쓴다).
  let topUrl: string | undefined;
  try {
    const frame = (await chrome.webNavigation.getFrame({ tabId, frameId: 0 })) as { url?: string; documentId?: string } | null;
    topUrl = frame?.documentId === documentId ? frame.url : undefined;
  } catch {
    topUrl = undefined;
  }
  const origin = loginOrigin(topUrl);
  if (!origin || loginOrigin(shape.topUrl) !== origin) {
    // https가 아니거나 페이지가 알려 준 주소와 다르면 비밀번호 관리자에 묻지 않는다(손 넘기기·카드로).
    calls.set(token, { tabId, documentId, origin: null, shape, entries: null, kpxError: null, chosen: null });
    return { token, origin: null, shape, manager: "none", managerError: null, entries: [] };
  }
  let entries: KpxEntry[] | null = null;
  let kpxError: string | null = null;
  // 칸이 든 문서가 같은 출처일 때만 그 주소로 묻는다(아니면 최상위 문서 주소로 묻고 판정에서 막는다).
  const lookupUrl = loginOrigin(shape.frameUrl) === origin ? shape.frameUrl : (topUrl ?? origin);
  try {
    entries = await keepassxcLogins(lookupUrl);
  } catch (err) {
    kpxError = err instanceof Error ? err.message : String(err);
    debugLog("keepassxc:get_logins", kpxError, "warn");
  }
  const call: SignInCall = { tabId, documentId, origin, shape, entries, kpxError, chosen: null };
  calls.set(token, call);
  // 카드가 오래 열려 있거나 대화가 끝나 정리되지 않아도 받은 값을 오래 두지 않는다.
  setTimeout(() => {
    if (calls.get(token) === call) calls.delete(token);
  }, CALL_TTL_MS);
  return {
    token,
    origin,
    shape,
    manager: kpxError ? "error" : entries === null ? "none" : "ok",
    managerError: kpxError,
    entries: (entries ?? []).map((e) => ({ uuid: e.uuid.toLowerCase(), name: e.name, login: e.login })),
  };
}

// 카드에서 고른 항목(이 호출이 받은 항목 중 하나만).
export function chooseSignInEntry(token: string, ids: readonly string[]): void {
  const c = calls.get(token);
  if (!c?.entries) return;
  const id = ids[0]?.toLowerCase();
  c.chosen = c.entries.some((e) => e.uuid.toLowerCase() === id) ? (id ?? null) : null;
}

export function chosenSignInEntry(token: string): string | null {
  return calls.get(token)?.chosen ?? null;
}

export function discardSignIn(token: string | null | undefined): void {
  if (token) calls.delete(token);
}

export interface SignInRunResult {
  ok: boolean;
  summary: string;
  data: { origin: string; step: LoginShape["step"]; submitted: boolean; note?: string };
}

// 항목 uuid의 값을 넣고 제출한다. 문서가 바뀌었으면 넣지 않는다.
export async function runSignIn(token: string, uuid: string, turnTab: TurnTab, signal?: AbortSignal): Promise<SignInRunResult> {
  // 승인 때의 구조 판정(제출 직전 재판정에서 새 이유만 막는다).
  const callId = token;
  const c = calls.get(token);
  calls.delete(token);
  // 기다리는 사이(일회용 코드 받기 등) 사용자가 멈췄거나 새 대화를 시작했으면 넣지 않는다.
  const checkAbort = () => {
    if (signal?.aborted) throw new Error("중단되어 로그인 정보를 넣지 않았습니다.");
  };
  checkAbort();
  if (!c || !c.origin) throw new Error("로그인 칸을 다시 확인하세요(find_form_fields로 다시 찾은 뒤 sign_in).");
  // 승인·판정한 탭이 지금 이 대화의 작업 탭이어야 한다.
  if ((await resolveTurnTab(turnTab)) !== c.tabId) throw new Error("로그인 칸을 확인한 탭이 아니어서 넣지 않았습니다. 다시 관측하세요.");
  const entry = c.entries?.find((e) => e.uuid.toLowerCase() === uuid.toLowerCase());
  if (!entry) throw new Error("고른 비밀번호 관리자 항목이 없습니다.");
  if ((await topDocumentId(c.tabId)) !== c.documentId) throw new Error("로그인 칸을 확인한 뒤 페이지가 바뀌어 넣지 않았습니다. 다시 관측하세요.");
  const { shape } = c;
  const fills: Array<{ id: string; value: string }> = [];
  const secrets: string[] = [];
  if (shape.step === "otp") {
    if (!shape.otpId) throw new Error("일회용 코드 칸을 찾지 못했습니다.");
    const code = await keepassxcTotp(entry.uuid);
    fills.push({ id: shape.otpId, value: code });
    secrets.push(code);
  } else {
    if (shape.usernameId && entry.login) {
      fills.push({ id: shape.usernameId, value: entry.login });
      secrets.push(entry.login);
    }
    if (shape.step === "password") {
      if (!shape.passwordId) throw new Error("비밀번호 칸을 찾지 못했습니다.");
      if (!entry.password) throw new Error("고른 항목에 비밀번호가 없습니다.");
      fills.push({ id: shape.passwordId, value: entry.password });
      secrets.push(entry.password);
    }
  }
  if (!fills.length) throw new Error("넣을 값이 없습니다(항목에 아이디가 없음).");
  // 너무 짧은 값은 페이지가 다시 보여 줘도 가릴 수 없다(다른 글자와 겹쳐 가리기를 쓰지 않는다). 넣지 않고 직접 로그인하게 한다.
  // 줄바꿈이 든 값은 입력 칸이 지워 넣으므로 넣은 값과 페이지의 값이 달라진다(그 모양까지 가리지만 로그인도 실패한다). 넣지 않는다.
  if (secrets.some((v) => /[\r\n]/.test(v))) {
    throw new Error("아이디나 비밀번호에 줄바꿈이 있어 넣지 않았습니다. 사용자에게 직접 로그인해 달라고 하세요.");
  }
  // 페이지 글자 정리(공백 줄이기·앞뒤 자르기) 뒤에도 가릴 수 있는 길이여야 한다.
  if (secrets.some((v) => v.length < MIN_SECRET_LENGTH || v.replace(/\s+/g, " ").trim().length < MIN_SECRET_LENGTH)) {
    throw new Error(`아이디나 비밀번호가 ${MIN_SECRET_LENGTH}글자보다 짧아 값을 가릴 수 없어 넣지 않았습니다. 사용자에게 직접 로그인해 달라고 하세요.`);
  }
  checkAbort();
  // 넣은 뒤의 관측이 먼저 모델로 가지 않게, 넣기 전에 가림 목록에 둔다.
  await rememberSecrets(c.tabId, secrets);
  checkAbort();
  // 넣는 사이 중단되면 페이지에 알려 제출하지 않게 한다(넣은 값은 그대로 남지만 보내지는 않는다).
  const onAbort = () => void sendTo(c.tabId, c.documentId, { kind: "login_cancel", callId }, 1_000, "로그인 중단").catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  if ((await topDocumentId(c.tabId)) !== c.documentId) throw new Error("로그인 칸을 확인한 뒤 페이지가 바뀌어 넣지 않았습니다. 다시 관측하세요.");
  checkAbort();
  const res = await sendTo<{ filled: number; total: number; submitted: boolean; note?: string }>(
    c.tabId,
    c.documentId,
    {
      kind: "login_fill",
      callId,
      fills,
      submit: shape.hasForm ? { submitId: shape.submitId, submitUrls: shape.submitUrls, submitMethods: shape.submitMethods } : null,
      approved: { origin: c.origin, block: loginShapeBlock(shape, c.origin) },
    },
    20_000,
    "로그인 정보 넣기",
  )
    .catch((err) => {
      // 응답만 늦었을 수 있다(페이지가 나중에 넣고 제출). 페이지 쪽 호출을 취소해 늦은 제출을 막는다.
      onAbort();
      throw err;
    })
    .finally(() => signal?.removeEventListener("abort", onAbort));
  const base = { origin: c.origin, step: shape.step };
  const what = STEP_LABEL[shape.step];
  if (res.filled < res.total) {
    return { ok: false, summary: `${what}를 넣지 못했습니다. ${res.note ?? ""}`.trim(), data: { ...base, submitted: false, note: res.note } };
  }
  if (!res.submitted) {
    const note = res.note ?? "로그인 양식(<form>)이 아니어서 제출하지 않았습니다. 화면을 관측해 로그인 버튼을 click_element로 누르세요.";
    return { ok: true, summary: `${what}를 넣었습니다(제출 안 함).`, data: { ...base, submitted: false, note } };
  }
  // 제출 뒤: 문서가 바뀌었으면 다음 화면을 관측해야 한다. 같은 문서에 비밀번호 칸이 그대로면 실패일 수 있다.
  await waitForNavigationSettle(c.tabId, 10_000).catch(() => undefined);
  const now = await topDocumentId(c.tabId);
  if (now === c.documentId && shape.step === "password" && shape.passwordId) {
    await new Promise((r) => setTimeout(r, 800));
    const still = await sendTo<boolean>(c.tabId, c.documentId, { kind: "login_field_shown", id: shape.passwordId }, 3_000, "로그인 결과 확인").catch(
      () => false,
    );
    if (still && (await topDocumentId(c.tabId)) === c.documentId) {
      return {
        ok: false,
        summary: `${what}를 넣고 제출했지만 비밀번호 칸이 그대로 있습니다(로그인 실패일 수 있음). 다시 시도하지 말고 화면을 관측해 사용자에게 알리세요.`,
        data: { ...base, submitted: true, note: "비밀번호 칸이 그대로 있음" },
      };
    }
  }
  return {
    ok: true,
    summary: `${c.origin}에 ${what}를 넣고 제출했습니다. 로그인이 끝났는지는 화면을 다시 관측해 확인하세요.`,
    data: { ...base, submitted: true },
  };
}
