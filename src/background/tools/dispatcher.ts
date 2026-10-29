import {
  autoApproveBlock,
  decodeDeepText,
  DESTRUCTIVE_REASON,
  destructiveClickBlock,
  destructiveFillBlock,
  destructiveRoute,
  looksPersonalValue,
} from "@/lib/autoApprove";
import { navigateAutoBlock } from "@/lib/siteTrust";
import { fillLink } from "@/lib/savedPages";
import { markUsed, savedLinkById } from "../savedPagesStore";
import { debugLog } from "../debug";
import { downloadScope, imageDownloadSources } from "@/lib/chatGrant";
import { DOWNLOAD_LIMITS } from "@/lib/downloadPick";
import { snapshotDownloads, takeChosenDownloads } from "../downloadChoices";
import { MAX_TABS_PER_CALL, readChosenTabs, snapshotCandidates } from "../otherTabs";
import { readChosenLinks, snapshotLinks } from "../linkedPages";
import type {
  ClickableElement,
  FileLinkList,
  FormField,
  PageContent,
  PageDescription,
  PageImage,
  ToolName,
  YoutubeTranscript,
} from "@/lib/messages";
import { toolArgsSchemas, type ToolArgs } from "@/lib/schemas";
import { DEFAULT_DOWNLOAD_FOLDER, normalizeNavigationUrl } from "@/lib/sanitize";
import { getSettings } from "../storage";
import {
  callContentTool,
  currentToolTab,
  followingPopup,
  followingTabPopup,
  recheckTabPopup,
  isMissingReceiver,
  pruneClosedPopups,
  queryContent,
  resolveTurnTab,
  stopFollowingPopups,
  takeTabNote,
  type TurnTab,
} from "./handlers";
import { ClickAbortedError, settlePopups, watchNewTabs, watchWindowOpen } from "../popups";
import { clickWithInput, type InputClickResult, type InputSession } from "../trustedInput";
import { runDownloads, type DownloadRunResult } from "./downloads";
import { captureFullPage, captureTarget, captureVisible, type CaptureResult, type CaptureTarget } from "./capture";
import { CAPTURE_LIMITS } from "@/lib/pageCapture";
import { markOptimisticNavigation, waitForNavigationSettle } from "../navigation";
import {
  clickCard,
  describeEffect,
  fillCard,
  handoffFillList,
  navKind,
  type ClickEffect,
  type DomEffect,
  type TargetInfo,
} from "@/lib/actionTarget";
import {
  appendRows,
  listSheets,
  parseMarkdownTable,
  readRange,
  writeRange,
} from "../google/sheets";
import { exportFile, listRecent, searchFiles } from "../google/drive";
import { readDocument } from "../document";
import { checkFileUrl } from "@/lib/fileFormat";
import {
  isPreActionStop,
  logTarget,
  pageKeyId,
  reasonCode,
  summarizeClickEffect,
  urlPattern,
  type ActionLogEntry,
  type ActionOutcome,
  type LoggedTarget,
  type PageKey,
} from "@/lib/actionLog";
import { finishAction, notePendingAction } from "../actionLog";
import { noteRead, readHintsFor } from "../readRecipes";
import { recipeArgs, usefulResult, type ReadHint } from "@/lib/readRecipe";
import { prepareSignIn, runSignIn, stepLabel, type SignInPreview } from "../signIn";
import { loginShapeBlocks } from "@/lib/loginPolicy";
import { httpOrigin } from "@/lib/url";

export interface ToolExecResult {
  ok: boolean;
  summary: string;
  data: unknown;
}

export interface ToolPreview {
  summary: string;
  details?: unknown;
  // 직접 조작할 사이트의 손 넘기기 카드에 보일 내용(입력할 칸과 값 전체). 없으면 details.
  handoffDetails?: string;
  // 자동 실행을 켰을 때도 승인을 받아야 하는 이유(결제·개인정보 제출). 없으면 null. 대상을 보지 않는 도구는 비워 둔다.
  autoBlock?: string | null;
  // 자동 실행·이번 요청 링크 이동 허락·이번 대화 허락 어느 것으로도 건너뛰지 않고 늘 카드로 묻는 이유
  // (#62 되돌리기 어려운 동작 — 삭제·스팸). 없으면 null.
  alwaysAsk?: string | null;
  // 클릭 대상 링크의 주소(자동 실행 사이트 경계 판정용).
  linkHrefs?: string[];
  // 입력할 값들(사이트 경계 판정용).
  fillValues?: string[];
  // 입력 칸 문서의 기준 주소(<base href> 포함). 상대 주소 입력값은 이 기준으로도 풀어 본다.
  baseUrls?: string[];
  // 클릭 대상(이번 요청 동안 링크 이동 허락 판정용, grantableLink).
  clickTarget?: TargetInfo;
  // 선택 카드(다른 탭 고르기)의 후보와 최대 선택 수.
  choices?: Array<{ id: string; label: string; sub: string }>;
  choiceLimit?: number;
  choiceDefaults?: string[];
  // 이번 대화 허락(#53)으로 덮지 못하는 구조적 이유(경고 링크 섞임, 페이지에 없는 이미지 등). 없으면 null.
  grantBlock?: string | null;
  // 이번 대화 허락의 범위(download_images의 저장 폴더). 같은 범위일 때만 허락을 쓴다.
  grantScope?: string;
  // 이번 대화 허락으로 카드 없이 실행할 때 고른 것으로 할 후보 id(read_linked_pages는 후보 전부, download_images는
  // 모델이 넘긴 주소의 후보 — 선택 해제로 함께 보인 페이지의 다른 이미지는 받지 않는다).
  grantChoiceIds?: string[];
  // 개인정보 모양만 걸린 주소(autoApproveBlock의 deferPersonalUrls)와, 사용자가 그 주소를 모두 허용했을 때의 자동 실행 판정.
  // 승인 카드에 "이 주소는 이번 대화에서 다시 묻지 않기"를 제안하고 허용한 주소면 autoBlock 대신 쓴다. 모델에는 보내지 않는다.
  // personalUrlKeys는 허용 판정에 쓰는 열쇠(personalUrlKey), personalUrls는 카드에 보일 주소(열쇠마다 하나).
  personalUrlKeys?: string[];
  personalUrls?: string[];
  autoBlockIfUrlsAllowed?: string | null;
  // 실행에 쓸 인자. 미리보기에서 정한 값(download_images의 저장 폴더)을 실행까지 고정한다. 없으면 모델 인자 그대로.
  execArgs?: unknown;
  // sign_in: 로그인 양식 모양·출처·비밀번호 관리자 항목(이름·아이디만, 값 없음). 승인 판정은 openrouter.ts가 한다.
  signIn?: SignInPreview;
}

function personalUrlFields(
  tool: "click_element" | "fill_form_fields",
  targets: TargetInfo[],
  values: ReadonlyArray<string | undefined> = [],
): Pick<ToolPreview, "personalUrlKeys" | "personalUrls" | "autoBlockIfUrlsAllowed"> {
  const deferred = new Map<string, string>();
  const block = autoApproveBlock(tool, targets, values, { deferPersonalUrls: deferred });
  return deferred.size
    ? { personalUrlKeys: [...deferred.keys()], personalUrls: [...deferred.values()], autoBlockIfUrlsAllowed: block }
    : {};
}

// 승인 카드를 띄우기 전에 대상이 find_* 때와 같은 요소인지 페이지에서 확인하고, 사람이 알아볼 기술을 받는다.
// content script는 이 기술을 이 호출(callId)의 승인 대상으로 남기고, 실행 직전에 다시 같은지 본다.
async function inspectTargets(
  ids: string[],
  prefix: "c" | "f",
  callId: string,
  turnTab: TurnTab,
  values?: string[],
): Promise<TargetInfo[]> {
  const tabId = await resolveTurnTab(turnTab);
  await waitForNavigationSettle(tabId, 10_000);
  // 탭으로 열린 팝업이면 기다린 뒤에도 앞에 보이는지 다시 본다(확인 실패면 오류로 멈춘다).
  await recheckTabPopup(turnTab, tabId);
  try {
    return await queryContent<TargetInfo[]>(tabId, { kind: "target_inspect", ids, callId, prefix, values }, 5_000, "대상 확인");
  } catch (err) {
    if (isMissingReceiver(err)) {
      throw new Error("대상을 찾은 페이지가 바뀌었습니다. find_clickables·find_form_fields로 다시 찾으세요.");
    }
    // 원래 탭에서 찾은 id를 팝업 창에 쓰면(또는 반대) 그 문서에는 없는 id라 실패한다. 어느 창인지 덧붙인다.
    if (followingPopup(turnTab) && err instanceof Error) {
      throw new Error(`${err.message} (지금 도구는 팝업 창에서 동작합니다. 원래 탭에서 찾은 id는 팝업 창에서 쓸 수 없습니다.)`);
    }
    throw err;
  }
}

// 지금 탭의 페이지 키. 기록을 껐거나 시크릿 창이거나 http(s)가 아니면 null(기록도 레시피도 쓰지 않음).
// 뼈대를 못 구하면 skeleton은 ""(레시피 후보는 내지 않는다).
async function pageKeyFor(turnTab: TurnTab): Promise<PageKey | null> {
  try {
    if (!(await getSettings()).actionLogEnabled) return null;
    const tabId = await resolveTurnTab(turnTab);
    const tab = await chrome.tabs.get(tabId);
    if (tab.incognito) return null;
    const pattern = urlPattern(tab.url ?? "");
    if (!pattern) return null;
    try {
      const skeleton = await queryContent<string>(tabId, { kind: "page_skeleton" }, 2_000, "페이지 뼈대");
      return { ...pattern, skeleton };
    } catch {
      return { ...pattern, skeleton: "" };
    }
  } catch {
    return null;
  }
}

// 동작 기록을 시작한다: 페이지 키를 구해 이 호출의 기록을 열어 둔다.
// 기록은 부가 기능이라 실패해도 승인 카드와 실행을 막지 않는다.
async function beginActionLog(
  callId: string,
  tool: "click_element" | "fill_form_fields",
  turnTab: TurnTab,
  targets: LoggedTarget[],
): Promise<void> {
  const page = await pageKeyFor(turnTab);
  if (page) notePendingAction(turnTab, callId, tool, page, targets);
}

// 읽기 도구 결과를 읽기 레시피 관찰로 남긴다(턴이 끝날 때 반영). before는 실행 전에 구한 페이지 키.
// 실행 뒤에 다시 구한 키가 다르면 그 사이 페이지가 바뀐 것이라 어느 페이지의 결과인지 알 수 없어 버린다.
async function observeRead(
  turnTab: TurnTab,
  before: PageKey | null,
  picked: NonNullable<ReturnType<typeof recipeArgs>>,
  data: unknown,
  failed: boolean,
) {
  if (!before?.skeleton) return;
  const useful = !failed && usefulResult(picked.tool, data);
  // 제안한 레시피를 그대로 다시 부른 것이면 로그에 남긴다(#156).
  const offered = offeredHints.get(turnKeyOf(turnTab));
  if (offered && offered.page === pageKeyId(before) && offered.hints.some((h) => h.tool === picked.tool && sameRecipeArgs(h.args, picked.args))) {
    debugLog("read_recipe:used", `${picked.tool} ${recipeArgsText(picked.args)} · ${useful ? "결과 있음" : "결과 없음"}`);
  }
  const after = await pageKeyFor(turnTab);
  if (!after || pageKeyId(after) !== pageKeyId(before)) return;
  noteRead(turnTab, before, picked.tool, picked.args, useful);
}

export async function buildToolPreview(
  toolName: ToolName,
  parsedArgs: unknown,
  callId: string,
  turnTab: TurnTab,
): Promise<ToolPreview> {
  switch (toolName) {
    case "fill_form_fields": {
      const args = parsedArgs as ToolArgs["fill_form_fields"];
      const infos = await inspectTargets(
        args.fills.map((f) => f.id),
        "f",
        callId,
        turnTab,
        args.fills.map((f) => f.value),
      );
      await beginActionLog(
        callId,
        "fill_form_fields",
        turnTab,
        infos.map((info, i) => logTarget(info, args.fills[i].value)),
      );
      const fillCardInfo = fillCard(infos.map((info, i) => ({ info, value: args.fills[i].value })));
      // 삭제·스팸 신호가 있는 칸(change 처리기가 지우는 체크박스 등)도 클릭처럼 늘 묻는다(#62).
      const fillValues = args.fills.map((f) => f.value);
      const destructiveFill = destructiveFillBlock(infos, fillValues);
      return {
        ...fillCardInfo,
        handoffDetails: `${handoffFillList(infos.map((info, i) => ({ info, value: args.fills[i].value })))}${
          destructiveFill ? `\n⚠ ${destructiveFill}일 수 있습니다. 입력 전에 대상을 확인하세요.` : ""
        }`,
        ...(destructiveFill
          ? { details: `${fillCardInfo.details}\n⚠ ${destructiveFill}일 수 있습니다. 입력 전에 대상을 확인하세요.` }
          : {}),
        autoBlock: autoApproveBlock("fill_form_fields", infos, fillValues),
        ...personalUrlFields("fill_form_fields", infos, fillValues),
        alwaysAsk: destructiveFill,
        // 양식 제출 주소(기존 값 포함)와 선택지 주소. 입력할 값은 fillValues로 따로 본다.
        linkHrefs: infos
          .flatMap((info) => [
            info.submitTo ?? "",
            info.submitUrl ?? "",
            ...(info.choiceUrls ?? []),
            ...(info.scopeSubmitUrls ?? []),
            // 입력은 change 처리기가 주변 양식(기본값 상태 포함)에 값을 옮겨 제출할 수 있어 그 action도 경계를 본다.
            ...(info.scopeFormActions ?? []),
            // 양식 안 칸도 change 처리기가 값을 주변 양식에 옮겨 제출할 수 있어 그 action의 사이트 경계를 본다.
            ...(info.aroundFormActions ?? []),
            // checkbox·radio 채우기는 칸을 실제로 누르므로 클릭처럼 감싼 링크와 ping 주소의 사이트 경계도 본다.
            info.ancestorHref ?? "",
            ...(info.pingUrls ?? []),
            // 값을 바꾸거나 누르면 일으킬 htmx GET 요청의 목적지.
            ...(info.requestUrls ?? []),
          ])
          .filter(Boolean),
        fillValues: args.fills.map((f) => f.value),
        baseUrls: [...new Set(infos.map((info) => info.baseUri ?? "").filter(Boolean))],
      };
    }
    case "sign_in": {
      const args = parsedArgs as ToolArgs["sign_in"];
      const signIn = await prepareSignIn(args.id, callId, turnTab);
      const where = signIn.origin ?? "이 페이지";
      // 카드에는 실제로 보낼 곳과 구조상 위험을 모두 보인다(사용자가 본 위험만 승인한 것으로 친다 — runSignIn이 같은 목록을 쓴다).
      const dests = [...new Set(signIn.shape.submitUrls.map((u) => httpOrigin(u) ?? u))];
      const risks = signIn.origin ? loginShapeBlocks(signIn.shape, signIn.origin) : [];
      return {
        summary: `${where}의 로그인 화면에 비밀번호 관리자(KeePassXC)의 ${stepLabel(signIn.shape.step)}를 넣고 ${
          signIn.shape.hasForm ? "제출합니다" : "넣습니다(제출은 하지 않음)"
        }. 넣을 항목을 고르세요.`,
        details: [
          "값은 도우미가 직접 넣고 모델에는 보내지 않습니다.",
          ...(dests.length ? [`보내는 곳: ${dests.join(", ")}`] : []),
          ...risks.map((r) => `⚠ ${r}`),
        ].join("\n"),
        choices: signIn.entries.map((e) => ({ id: e.uuid, label: e.name || e.login || "(이름 없음)", sub: e.login })),
        choiceLimit: 1,
        choiceDefaults: [],
        signIn,
      };
    }
    case "download_images":
    case "download_files": {
      const args = parsedArgs as ToolArgs["download_images"] | ToolArgs["download_files"];
      const kind = toolName === "download_images" ? "image" : "file";
      const { downloadFolderPrefix } = await getSettings();
      // 빈 값도 실제로 저장할 기본 폴더로 확정한다(카드·허락 판정·실행이 같은 폴더를 보게).
      const folder = args.folderPrefix || downloadFolderPrefix || DEFAULT_DOWNLOAD_FOLDER;
      // 지금 페이지에 실제로 있는 이미지·링크인지 확인해 후보를 고정한다. 실행은 사용자가 고른 후보만 받는다.
      const snap = await snapshotDownloads(callId, turnTab, kind, args.urls);
      const limit = DOWNLOAD_LIMITS[kind].maxPick;
      const what =
        kind === "image"
          ? `이미지를 '${folder}/' 폴더에 저장합니다.`
          : `첨부·다운로드 파일을 로그인 쿠키와 함께 받아 '${folder}/' 폴더에 저장합니다.`;
      const extra = snap.choices.length > snap.requestedIds.length ? " 모델이 고르지 않은 페이지 항목은 선택 해제로 함께 보입니다." : "";
      return {
        summary: `${what} 저장할 항목을 고르세요(최대 ${limit}개).${extra}`,
        ...(snap.rejected.length ? { details: `받지 않는 주소:\n${snap.rejected.join("\n")}` } : {}),
        choices: snap.choices,
        choiceLimit: Math.min(limit, snap.choices.length),
        choiceDefaults: snap.defaults,
        // 첨부 파일은 이번 대화 허락 대상이 아니다(쿠키를 실어 받으므로 늘 카드에서 고른다).
        ...(kind === "image"
          ? { grantBlock: snap.grantBlock, grantScope: downloadScope(folder), grantChoiceIds: snap.requestedIds }
          : {}),
        // 폴더를 생략한 호출은 실행 때 설정을 다시 읽지 않고, 카드·허락 판정에 쓴 이 폴더에 저장한다.
        execArgs: { ...args, folderPrefix: folder },
      };
    }
    case "capture_page": {
      const args = parsedArgs as ToolArgs["capture_page"];
      // 캡처할 수 없는 탭(내부 페이지·웹 스토어 등)이거나 앞에 보이는 탭이 아니면 카드 없이 이유를 알린다.
      const target = await captureTarget(turnTab);
      const { downloadFolderPrefix } = await getSettings();
      const folder = args.folderPrefix || downloadFolderPrefix || DEFAULT_DOWNLOAD_FOLDER;
      let host = "";
      try {
        host = new URL(target.url).host;
      } catch {
        host = "";
      }
      const tabLabel = followingPopup(turnTab) ? "따라가는 팝업 창" : "지금 탭";
      const where = host ? `${tabLabel}(${host})` : tabLabel;
      return {
        summary: args.fullPage
          ? `${where}의 페이지 전체를 맨 위부터 스크롤하며 캡처해(높이 최대 ${CAPTURE_LIMITS.maxPageHeight.toLocaleString("en-US")}px) PNG로 '${folder}/' 폴더에 저장합니다. 캡처하는 동안 페이지가 스크롤되고 고정 머리글 등이 잠시 숨겨지며, 끝나면 원래 위치와 모습으로 되돌립니다.`
          : `${where}의 보이는 화면을 캡처해 PNG로 '${folder}/' 폴더에 저장합니다.`,
        details:
          "화면에 보이는 내용(입력한 값·개인정보 포함)이 그대로 이미지에 담깁니다. 이미지는 이 기기에만 저장하고 모델 제공자로 보내지 않습니다.",
        // 폴더를 생략한 호출은 실행 때 설정을 다시 읽지 않고, 카드에 보인 이 폴더에 저장한다. 카드에 보인 대상(탭·주소·
        // 문서)도 이 호출에 고정해, 카드가 열린 사이 다른 페이지로 이동했으면 실행에서 찍지 않는다.
        execArgs: { ...args, folderPrefix: folder, approvedTarget: target },
      };
    }
    case "click_element": {
      const args = parsedArgs as ToolArgs["click_element"];
      const [info] = await inspectTargets([args.id], "c", callId, turnTab);
      await beginActionLog(callId, "click_element", turnTab, [logTarget(info)]);
      // 선택지(option·menuitem*)는 펼친 트리거의 위험 정보도 따로 받는다. 승인·사이트 판정은 선택지와 트리거
      // 양쪽을 모두 본다(하나로 합치지 않아 어느 쪽의 목적지·위험 문구도 사라지지 않는다).
      const sides = info.trigger ? [info, info.trigger] : [info];
      const card = clickCard(info);
      // 되돌리기 어려운 동작(삭제·스팸)은 자동 실행이 꺼져 있어도 카드에 경고를 붙인다(#62).
      const destructive = destructiveClickBlock(sides);
      return {
        ...card,
        ...(destructive ? { details: `${card.details}\n⚠ ${destructive}입니다. 누르기 전에 대상을 확인하세요.` } : {}),
        autoBlock: autoApproveBlock("click_element", sides),
        ...personalUrlFields("click_element", sides),
        alwaysAsk: destructive,
        // 트리거가 있는 선택지는 링크 이동 허락(grantableLink) 대상이 아니다.
        ...(info.trigger ? {} : { clickTarget: info }),
        linkHrefs: sides
          .flatMap((t) => [
            t.href,
            t.submitTo ?? "",
            t.submitUrl ?? "",
            t.ancestorHref ?? "",
            ...(t.choiceUrls ?? []),
            ...(t.scopeSubmitUrls ?? []),
            ...(t.pingUrls ?? []),
            // 누르면 일으킬 htmx GET 요청의 목적지.
            ...(t.requestUrls ?? []),
          ])
          .filter(Boolean),
      };
    }
    case "read_linked_pages": {
      const args = parsedArgs as ToolArgs["read_linked_pages"];
      const { choices, defaults, rejected, grantBlock } = await snapshotLinks(callId, turnTab, args.urls);
      return {
        summary: `페이지의 링크 ${choices.length}개를 탭 이동 없이(로그인 쿠키 없이) 받아 본문을 읽습니다. 읽을 링크를 고르세요. 읽은 내용은 모델 제공자로 전송됩니다.`,
        ...(rejected.length ? { details: `읽지 않는 주소:\n${rejected.join("\n")}` } : {}),
        choices,
        choiceLimit: choices.length,
        choiceDefaults: defaults,
        grantBlock,
        grantChoiceIds: choices.map((c) => c.id),
      };
    }
    case "read_other_tabs": {
      const args = parsedArgs as ToolArgs["read_other_tabs"];
      const choices = await snapshotCandidates(callId, turnTab);
      return {
        summary: `다른 탭의 본문을 읽어 대화에 넣습니다: ${truncate(args.purpose, 120)}. 읽을 탭을 고르세요(최대 ${MAX_TABS_PER_CALL}개). 고른 탭의 내용은 모델 제공자로 전송됩니다.`,
        choices,
        choiceLimit: MAX_TABS_PER_CALL,
      };
    }
    case "read_document": {
      const args = parsedArgs as ToolArgs["read_document"];
      const checked = checkFileUrl(args.url);
      if (!checked.ok) throw new Error(`read_document: ${checked.reason}`);
      const target = checked.target;
      const host = new URL(target.url).host;
      const warning = `URL 전체(쿼리 포함)가 ${host}로 전송됩니다. 모르는 사이트이거나 쿼리에 대화 내용이 들어 있으면 거부하세요.`;
      if (!target.hint) {
        // 확장자가 없으면 이 주소가 파일인지 미리 알 수 없다. 승인 카드가 주된 방어선이다.
        return {
          summary: `${host}의 다운로드 링크를 로그인 쿠키와 함께 호출해, 받은 파일을 읽습니다(형식은 받은 뒤 판별).`,
          details: `${target.url}\n\n확장자가 없는 링크라 파일 다운로드가 아닌 다른 동작(로그아웃·삭제·신청 등)을 하는 주소일 수도 있습니다. 페이지에 보이는 첨부 파일 링크가 맞을 때만 허용하세요.\n${warning}`,
        };
      }
      return {
        summary: `${host}에서 파일 '${truncate(target.filename, 60)}'을(를) 로그인 쿠키와 함께 내려받아 읽습니다.`,
        details: `${target.url}\n\n${warning}`,
      };
    }
    case "open_saved_link": {
      const args = parsedArgs as ToolArgs["open_saved_link"];
      const link = await savedLinkById(args.id);
      const url = normalizeNavigationUrl(fillLink(link, args.values));
      const host = new URL(url).hostname;
      const values = Object.values(args.values ?? {});
      // 사용자가 저장한 출처·경로라 자동 실행은 구조로 허용한다(#86 사용자 결정). 다만 자리 값은 모델이 만든 값이라
      // navigate_to_url과 같은 경계를 저장한 출처 하나를 신뢰 사이트로 두고 본다: 값에 실린 다른 사이트 주소(리다이렉트
      // 매개변수 등, 내장 주소 풀기)·결제·개인정보 주소·삭제 경로면 묻는다. 값이 개인정보 모양이어도 묻는다.
      const personal = values.some((v) => looksPersonalValue(decodeDeepText(v))) ? "자리 값이 개인정보처럼 보임" : null;
      const destructive = destructiveRoute(url) ? DESTRUCTIVE_REASON : null;
      return {
        summary: `${followingPopup(turnTab) ? "팝업 창 따라가기를 멈추고 원래 탭에서 " : ""}저장한 링크 '${truncate(link.name, 60)}'을(를) 엽니다(${host}).`,
        details: `${link.purpose ? `용도: ${link.purpose}\n` : ""}${url}${destructive ? `\n⚠ ${destructive}일 수 있습니다. 여는 주소를 확인하세요.` : ""}`,
        autoBlock: personal ?? navigateAutoBlock(new Set([link.site]), url),
        // 되돌리기 어려운 동작은 어떤 허락으로도 건너뛰지 않고 묻는다(#62).
        alwaysAsk: destructive,
        execArgs: { ...args, url },
      };
    }
    case "navigate_to_url": {
      const args = parsedArgs as ToolArgs["navigate_to_url"];
      const url = normalizeNavigationUrl(args.url);
      const destination = new URL(url);
      return {
        summary: followingPopup(turnTab)
          ? `팝업 창 따라가기를 멈추고 원래 탭을 ${destination.hostname}(으)로 이동합니다.`
          : `현재 탭을 ${destination.hostname}(으)로 이동합니다.`,
        details: url,
      };
    }
    case "google_sheets_write_range": {
      const args = parsedArgs as ToolArgs["google_sheets_write_range"];
      const rowCount = args.values.length;
      const colCount = Math.max(...args.values.map((r) => r.length));
      const preview = args.values
        .slice(0, 5)
        .map((r) => r.slice(0, 5).map((c) => truncate(c, 40)).join(" | "))
        .join("\n");
      return {
        summary: `Google Sheets '${args.range}' 범위에 ${rowCount}×${colCount} 값 덮어쓰기.`,
        details: `스프레드시트: ${args.spreadsheetId}\n범위: ${args.range}\n\n미리보기 (최대 5×5):\n${preview}`,
      };
    }
    case "google_sheets_append_rows": {
      const args = parsedArgs as ToolArgs["google_sheets_append_rows"];
      return {
        summary: `Google Sheets '${args.range}' 끝에 ${args.values.length}행 추가.`,
        details: `스프레드시트: ${args.spreadsheetId}\n기준 범위: ${args.range}`,
      };
    }
    case "google_sheets_write_markdown_table": {
      const args = parsedArgs as ToolArgs["google_sheets_write_markdown_table"];
      return {
        summary: `Google Sheets '${args.range}'에 markdown 표 기록.`,
        details: args.markdownTable.slice(0, 400),
      };
    }
    default: {
      // 평소 승인 카드가 없는 도구(외부 본문 보호 중에 묻는 번역·Google 읽기 등)는 실제로 보낼 인자를 그대로 보여 준다.
      let details = "";
      try {
        details = JSON.stringify(parsedArgs, null, 1).slice(0, 800);
      } catch {
        details = "";
      }
      return { summary: `도구 ${toolName} 실행`, ...(details ? { details } : {}) };
    }
  }
}

// 클릭 뒤 이동이 시작될 틈. markOptimisticNavigation은 500ms 안에 이동이 시작되지 않으면 기다림을 푼다.
const CLICK_SETTLE_MS = 700;

async function tabUrl(tabId: number): Promise<string> {
  try {
    return (await chrome.tabs.get(tabId)).url ?? "";
  } catch {
    return "";
  }
}

async function observeClickEffect(
  tabId: number,
  before: string,
  token: string,
  newTabs: () => boolean,
): Promise<ClickEffect> {
  await new Promise((r) => setTimeout(r, CLICK_SETTLE_MS));
  await waitForNavigationSettle(tabId, 10_000);
  const url = (await tabUrl(tabId)) || before;
  let dom: DomEffect | null = null;
  let sameDocument: boolean | null;
  try {
    dom = await queryContent<DomEffect | null>(tabId, { kind: "action_effect", token }, 1_500, "클릭 결과 확인");
    // 관찰 기록이 없으면 클릭한 문서가 아니다(새 페이지가 떴다).
    sameDocument = dom !== null;
  } catch (err) {
    // 받는 쪽이 없으면 문서가 바뀌는 중이거나 content script가 없는 페이지다. 시간 초과는 페이지가 멈춘 것(알림창 등).
    sameDocument = isMissingReceiver(err) ? false : null;
  }
  return { navigation: navKind(before, url), url, sameDocument, newTab: newTabs(), dom };
}

const POPUP_WINDOW_NOTE =
  "팝업 창 — 원래 탭에서 누른 버튼이 연 창입니다. 도구는 이 창에서 동작하고, 창이 닫히면 원래 탭으로 돌아갑니다.";
const POPUP_TAB_NOTE =
  "따라가는 탭 — 원래 탭에서 누른 버튼·링크가 연 탭(새 탭, 또는 브라우저가 팝업을 탭으로 연 것)입니다. 도구는 이 탭이 앞에 보이는 동안 이 탭에서 동작하고, 탭이 닫히면 원래 탭으로 돌아갑니다.";

// 결과 요약: 시작·저장·실패 수와 저장한 이름(앞 몇 개), 실패 이유.
function downloadSummary(res: DownloadRunResult): string {
  const failed = res.results.filter((r) => !r.ok);
  const saved = res.results.filter((r) => r.ok && r.savedAs).map((r) => r.savedAs as string);
  const names = saved.length ? ` (${saved.slice(0, 3).map((n) => truncate(n, 60)).join(", ")}${saved.length > 3 ? ` 외 ${saved.length - 3}개` : ""})` : "";
  const fails = failed.length
    ? ` 실패 ${failed.length}개: ${failed
        .slice(0, 3)
        .map((r) => `${truncate(r.label || r.url, 40)}(${r.reason ?? ""})`)
        .join(", ")}`
    : "";
  const notes = res.results.filter((r) => r.note).length;
  return `${res.startedCount}개 다운로드 시작, ${res.savedCount}개 저장 완료${names}.${fails}${notes ? ` 확인 필요 ${notes}개.` : ""}`;
}

// 캡처 결과 요약: 저장한 이름(앞 몇 개)·크기, 실패 이유, 잘림.
function captureSummary(res: CaptureResult): string {
  const what = res.mode === "fullPage" ? `페이지 전체 캡처(화면 ${res.screens ?? 0}장 이어 붙임)` : "보이는 화면 캡처";
  const saved = res.images
    .filter((i) => i.ok && i.savedAs)
    .slice(0, 3)
    .map((i) => `${truncate(i.savedAs as string, 80)} ${i.width}×${i.height}px`);
  const failed = res.images.filter((i) => !i.ok).map((i) => i.reason ?? "");
  return (
    `${what}: ${res.savedCount}개 저장${saved.length ? ` (${saved.join(", ")})` : ""}.` +
    (failed.length ? ` 실패 ${failed.length}개(${failed.slice(0, 2).join(", ")}).` : "") +
    (res.truncated ? " 페이지 아래쪽은 잘림." : "")
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function parseToolArgs<T extends ToolName>(
  toolName: T,
  rawArgs: unknown,
): ToolArgs[T] {
  const schema = toolArgsSchemas[toolName];
  const result = schema.safeParse(rawArgs ?? {});
  if (!result.success) {
    throw new Error(`도구 '${toolName}' 인자 검증 실패: ${result.error.message}`);
  }
  return result.data as ToolArgs[T];
}

// 직접 조작할 사이트에서 사용자에게 넘긴 동작을 기록한다(실행하지 않음).
export function recordHandedOffAction(callId: string, turnTab: TurnTab): void {
  void finishAction(turnTab, callId, "handed_off");
}

// 사용자가 승인 카드에서 취소한 동작을 기록한다.
export function recordCancelledAction(callId: string, turnTab: TurnTab): void {
  void finishAction(turnTab, callId, "cancelled");
}

const RECIPE_TOOLS = new Set<ToolName>(["query_dom", "list_file_links", "find_clickables"]);

// 그 호출 하나에만 쓰는 실행 옵션. 대화 객체가 호출마다 만들어 넘기고 전역에 두지 않는다.
export interface ExecOptions {
  // 이번 대화 허락(#53)으로 카드 없이 실행하는 호출인지(실행하는 쪽이 명시). 데이터 유무로 추측하지 않는다.
  viaGrant?: boolean;
  // 허락 경로의 이미지 저장: 이 호출을 위해 쿠키 없이 미리 받은 이미지(주소 → data: 주소).
  grantImages?: ReadonlyMap<string, string>;
  // 이 대화의 실제 입력(디버거) 상태. 없으면 스크립트 클릭.
  inputSession?: InputSession;
}

// 패널 결과 줄에 붙이는 클릭 수단(실제 입력 설정이 켜졌을 때 어느 쪽으로 눌렀는지 보이게).
function inputLabel(data: InputClickResult): string {
  if (data.input === "trusted") return " · 실제 입력";
  return data.inputNote ? ` · 스크립트 클릭(${truncate(data.inputNote, 60)})` : "";
}

// 원래 탭을 웹 주소로 이동한다(navigate_to_url·open_saved_link). 팝업을 따라가던 중이면 따라가기를 끝낸다.
// 탭을 바꾸기 직전에 중단·새 요청을 확인한다(저장소·탭 조회를 기다리는 사이 턴이 끝났으면 이동하지 않는다).
async function navigateOriginalTab(
  url: string,
  turnTab: TurnTab,
  signal: AbortSignal | undefined,
): Promise<{ leftPopup: boolean; note: string }> {
  // 새 탭·설정 같은 내부 페이지에서도 웹 주소로는 이동할 수 있다(normalizeNavigationUrl이 http(s)만 통과시킨다).
  // 이동은 늘 원래 탭에서 한다. 팝업 창을 따라가던 중이면 따라가기를 끝낸다(팝업 창은 열린 채로 둔다).
  const tabId = await resolveTurnTab(turnTab, { allowInternal: true, originalTab: true });
  if (signal?.aborted) throw new Error("중단되어 이동하지 않았습니다.");
  // 탭으로 열린 팝업을 따라가던 중이면 원래 탭은 그 탭 뒤에 가려 있다. 이동하는 원래 탭을 앞으로 띄워 사용자가 보게 한다.
  const fromTabPopup = followingTabPopup(turnTab);
  const leftPopup = stopFollowingPopups(turnTab);
  markOptimisticNavigation(tabId);
  const moved = await chrome.tabs.update(tabId, fromTabPopup ? { url, active: true } : { url });
  // 탭 팝업 위에 팝업 창이 떠 있었으면 그 창이 포커스를 갖고 있다. 원래 탭의 창도 앞으로 가져온다.
  if (fromTabPopup && moved?.windowId !== undefined) {
    await chrome.windows.update(moved.windowId, { focused: true }).catch(() => {});
  }
  const note = fromTabPopup
    ? "팝업으로 열린 탭 따라가기를 멈추고 원래 탭을 앞으로 띄워 이동했습니다(팝업 탭은 열린 채로 둡니다). 이제 도구는 원래 탭에서 동작합니다."
    : "팝업 창 따라가기를 멈추고 원래 탭을 이동했습니다. 이제 도구는 원래 탭에서 동작합니다.";
  return { leftPopup, note };
}

export async function executeTool(
  toolName: ToolName,
  parsedArgs: unknown,
  callId: string,
  turnTab: TurnTab,
  signal?: AbortSignal,
  opts: ExecOptions = {},
): Promise<ToolExecResult> {
  if (RECIPE_TOOLS.has(toolName)) {
    const picked = recipeArgs(toolName, parsedArgs);
    if (!picked) return runTool(toolName, parsedArgs, callId, turnTab, signal, opts);
    const before = await pageKeyFor(turnTab);
    let result: ToolExecResult;
    try {
      result = await runTool(toolName, parsedArgs, callId, turnTab, signal, opts);
    } catch (err) {
      await observeRead(turnTab, before, picked, null, true);
      throw err;
    }
    await observeRead(turnTab, before, picked, result.data, false);
    return result;
  }
  if (toolName === "describe_page") {
    const result = await runTool(toolName, parsedArgs, callId, turnTab, signal, opts);
    return attachReadHints(result, turnTab);
  }
  if (toolName !== "click_element" && toolName !== "fill_form_fields") {
    return runTool(toolName, parsedArgs, callId, turnTab, signal, opts);
  }
  let result: ToolExecResult;
  try {
    result = await runTool(toolName, parsedArgs, callId, turnTab, signal, opts);
  } catch (err) {
    const reason = reasonCode(err instanceof Error ? err.message : String(err));
    void finishAction(turnTab, callId, isPreActionStop(reason) ? "aborted" : "failed", { reason });
    throw err;
  }
  const { outcome, extra } = actionOutcome(toolName, result);
  void finishAction(turnTab, callId, outcome, extra);
  return result;
}

// 턴 탭마다 마지막으로 제안한 레시피(페이지 키와 함께). 레시피 도구 호출이 그중 하나와 같으면 로그에 남긴다(#156).
const offeredHints = new Map<string, { page: string; hints: ReadHint[] }>();
const MAX_OFFERED = 20;

function turnKeyOf(turnTab: TurnTab): string {
  return "tabId" in turnTab ? String(turnTab.tabId) : "error";
}

// 턴을 시작할 때 그 탭의 예전 제안을 지운다(새 턴의 read_recipe:used는 이 턴에서 제안한 것만).
export function clearOfferedHints(turnTab: TurnTab): void {
  offeredHints.delete(turnKeyOf(turnTab));
}

// 레시피 인자를 로그용 한 줄로(값은 각 120자까지).
function recipeArgsText(args: Record<string, string | number | boolean>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? `'${truncate(v, 120)}'` : String(v)}`)
    .join(" ");
}

function sameRecipeArgs(a: Record<string, string | number | boolean>, b: Record<string, string | number | boolean>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

// describe_page 결과에 같은 구조의 페이지에서 전에 통한 읽기 방법을 붙인다. 실패해도 결과는 그대로 돌려준다.
async function attachReadHints(result: ToolExecResult, turnTab: TurnTab): Promise<ToolExecResult> {
  // 새 관측마다 이전 제안을 지운다(제안이 없는 관측 뒤나 새 대화에서 예전 제안으로 read_recipe:used를 남기지 않게).
  offeredHints.delete(turnKeyOf(turnTab));
  try {
    // 관측한 뒤 탭이 다른 주소로 옮겼으면, 지금 페이지의 후보를 관측 결과에 섞지 않는다.
    const observed = (result.data as PageDescription).url;
    const tab = await chrome.tabs.get(await resolveTurnTab(turnTab));
    if (!observed || tab.url !== observed) return result;
    const page = await pageKeyFor(turnTab);
    if (!page?.skeleton) return result;
    const hints = await readHintsFor(page);
    if (!hints.length) return result;
    offeredHints.set(turnKeyOf(turnTab), { page: pageKeyId(page), hints });
    while (offeredHints.size > MAX_OFFERED) {
      const oldest = offeredHints.keys().next().value;
      if (oldest === undefined) break;
      offeredHints.delete(oldest);
    }
    // 제안한 레시피의 도구·인자를 디버그 로그에 남긴다(#156). 모델이 만든 인자만 — 입력 칸 값은 없다.
    for (const h of hints) debugLog("read_recipe:offered", `${h.tool} ${recipeArgsText(h.args)} · 성공 ${h.successes}번`);
    return {
      ...result,
      summary: `${result.summary} / 전에 통한 읽기 방법 ${hints.length}개`,
      data: { ...(result.data as PageDescription), readHints: hints },
    };
  } catch {
    return result;
  }
}

function actionOutcome(
  toolName: "click_element" | "fill_form_fields",
  result: ToolExecResult,
): { outcome: ActionOutcome; extra: Pick<ActionLogEntry, "effect" | "fill" | "reason"> } {
  if (toolName === "click_element") {
    const effect = (result.data as { effect: ClickEffect }).effect;
    if (effect.dom?.aborted) return { outcome: "aborted", extra: { reason: "target_changed" } };
    return { outcome: result.ok ? "done" : "failed", extra: { effect: summarizeClickEffect(effect) } };
  }
  const data = result.data as { filledCount: number; results: Array<{ applied: boolean; note?: string }> };
  const fill = { applied: data.filledCount, total: data.results.length };
  const reasons = data.results.filter((r) => !r.applied).map((r) => reasonCode(r.note ?? ""));
  if (!reasons.length) return { outcome: "done", extra: { fill } };
  const outcome: ActionOutcome =
    fill.applied > 0 ? "partial" : reasons.every(isPreActionStop) ? "aborted" : "failed";
  return { outcome, extra: { fill, reason: reasons[0] } };
}

// click_element: 누르고 뒤따른 이동·화면 변화·팝업(새 창·새 탭·닫힘)을 관측해 결과로 돌려준다.
async function clickTool(
  parsedArgs: unknown,
  callId: string,
  turnTab: TurnTab,
  signal: AbortSignal | undefined,
  opts: ExecOptions,
): Promise<ToolExecResult> {
  const tabId = await resolveTurnTab(turnTab);
  const clickedPopup = followingPopup(turnTab);
  const before = await tabUrl(tabId);
  // 클릭 직전 이 탭이 있던 창(팝업이 탭으로 열렸을 때 같은 창의 앞에 떴는지 보는 기준).
  const sourceWindowId = await chrome.tabs.get(tabId).then((t) => t.windowId, () => null);
  const newTabs = watchNewTabs(tabId);
  // 클릭하는 동안만 페이지의 window.open을 지켜본다(팝업 차단·주소). 읽을 때 원래 함수로 되돌린다.
  let readOpens: Awaited<ReturnType<typeof watchWindowOpen>>;
  try {
    readOpens = await watchWindowOpen(tabId, signal);
  } catch (err) {
    newTabs.stop();
    throw err;
  }
  let data: InputClickResult;
  try {
    // 관찰을 넣는 사이 사용자가 중단했거나 새 요청을 보냈으면 승인한 클릭이라도 누르지 않는다.
    if (signal?.aborted) throw new ClickAbortedError();
    // 설정이 켜져 있으면 실제 입력 클릭(0.2.0), 아니면 스크립트 클릭.
    data = await clickWithInput(parsedArgs, callId, turnTab, signal, opts.inputSession);
  } catch (err) {
    const createdEarly = newTabs.stop();
    void readOpens();
    // 누른 팝업 창이 응답하기 전에 닫혔으면(고르자마자 닫히는 달력) 실패가 아니라 창이 닫힌 결과로 알린다.
    // 중단해서 누르지 않은 경우는 그대로 중단으로 알린다.
    if (clickedPopup && !(err instanceof ClickAbortedError)) {
      const back = await pruneClosedPopups(turnTab);
      if (back) {
        takeTabNote(turnTab);
        // 닫히기 전에 새 팝업 창을 열었으면(다음 단계 창) 남은 창 위에 이어 따라간다.
        const opened = await settlePopups(turnTab, before, createdEarly, { calls: [], complete: false }, tabId, sourceWindowId);
        const effect: ClickEffect = {
          navigation: "none",
          url: before,
          sameDocument: null,
          newTab: createdEarly.some((t) => !t.reused),
          dom: null,
          popup: { ...(opened ?? {}), closed: back },
        };
        return {
          ok: true,
          summary: `팝업 창 클릭: ${describeEffect(effect)}`,
          data: { text: "", href: "", effect, note: describeEffect(effect) },
        };
      }
    }
    throw err;
  }
  markOptimisticNavigation(tabId);
  let created: ReturnType<typeof newTabs.stop> = [];
  const effect = await observeClickEffect(tabId, before, data.effectToken, () => {
    created = newTabs.stop();
    return created.some((t) => !t.reused);
  });
  const opens = await readOpens();
  // 클릭한 팝업 창이 클릭 뒤 닫혔으면(고른 값을 원래 페이지에 써 넣고 닫히는 달력 등) 아래 창으로 돌아간다.
  // 결과 문구가 돌아간 것을 알리므로 다음 도구 결과에는 따로 붙이지 않는다.
  let closed: "original" | "popup" | null = null;
  if (clickedPopup) {
    closed = await pruneClosedPopups(turnTab);
    if (closed) takeTabNote(turnTab);
  }
  // 닫힘 정리 뒤에 새 창을 등록한다: 닫히면서 다음 창을 연 팝업(A가 B를 열고 닫힘)이면 B를 남은 창(원래 탭이나
  // 그 아래 팝업) 위에 쌓아 따라간다.
  const popup = await settlePopups(turnTab, before, created, opens, tabId, sourceWindowId);
  if (popup || closed) effect.popup = { ...(popup ?? {}), ...(closed ? { closed } : {}) };
  return {
    ok: data.clicked && !effect.dom?.aborted,
    summary: `'${truncate(data.text, 60) || "(글자 없음)"}' 클릭: ${describeEffect(effect)}${inputLabel(data)}`,
    // 팝업 창이 열리거나 막히거나 닫혔거나, 같은 문서 안에서 주소가 바뀌었거나(목록 다시 찾기 안내) 대화상자가 열렸으면(#158)
    // 모델이 놓치지 않게 고정 문구(줄인 주소만 포함)를 함께 싣는다.
    data: { text: data.text, href: data.href, effect, ...(clickNoteNeeded(effect) ? { note: describeEffect(effect) } : {}) },
  };
}

function clickNoteNeeded(effect: ClickEffect): boolean {
  return !!effect.popup || !!effect.dom?.dialogOpened || (effect.navigation === "same_origin" && effect.sameDocument === true);
}

async function runTool(
  toolName: ToolName,
  parsedArgs: unknown,
  callId: string,
  turnTab: TurnTab,
  signal?: AbortSignal,
  opts: ExecOptions = {},
): Promise<ToolExecResult> {
  switch (toolName) {
    case "describe_page": {
      const raw = await callContentTool<PageDescription>(toolName, parsedArgs, callId, turnTab);
      // 관측한 창이 따라가는 팝업 창이면 모델이 어느 창을 보고 있는지 알 수 있게 적는다.
      const current = await currentToolTab(turnTab);
      const inPopup = current?.popup === true;
      const data: PageDescription = inPopup ? { ...raw, window: current?.asTab ? POPUP_TAB_NOTE : POPUP_WINDOW_NOTE } : raw;
      const regionList =
        data.landmarks.map((l) => `${l.region}(${l.clickableCount})`).join(", ") || "없음";
      return {
        ok: true,
        summary: `${inPopup ? "팝업 창 " : ""}페이지 관측: ${truncate(data.title, 40)} / 랜드마크: ${regionList}`,
        data,
      };
    }
    case "get_page_content": {
      const data = await callContentTool<PageContent>(toolName, parsedArgs, callId, turnTab);
      return {
        ok: true,
        summary: `본문 ${data.wordCount}자 추출: ${truncate(data.title, 60)}`,
        data,
      };
    }
    case "get_youtube_transcript": {
      const data = await callContentTool<YoutubeTranscript>(toolName, parsedArgs, callId, turnTab);
      return {
        ok: true,
        summary:
          `스크립트 ${data.segmentCount}줄 추출: ${truncate(data.title, 60)}` +
          (data.truncated ? " (일부 잘림)" : "") +
          (data.complete ? "" : " (로딩 미완료, 뒷부분 누락 가능)"),
        data,
      };
    }
    case "read_linked_pages": {
      const data = await readChosenLinks(callId, signal);
      const okCount = data.filter((d) => "text" in d).length;
      return {
        ok: okCount > 0,
        summary: `링크 ${data.length}개 중 ${okCount}개 읽음`,
        data,
      };
    }
    case "read_other_tabs": {
      const data = await readChosenTabs(callId, turnTab, signal);
      const okCount = data.filter((d) => "mainText" in d).length;
      return {
        ok: okCount > 0,
        summary: `다른 탭 ${data.length}개 중 ${okCount}개 읽음: ${data.map((d) => truncate(d.title || d.origin, 30)).join(", ")}`,
        data,
      };
    }
    case "read_document": {
      const data = await readDocument(parsedArgs as ToolArgs["read_document"], signal);
      return {
        ok: true,
        summary:
          `문서 읽기: ${truncate(data.filename, 60)} (${data.format}, ${data.totalChars}자)` +
          (data.truncated ? ` (앞 ${data.markdown.length}자만 전달)` : ""),
        data,
      };
    }
    case "list_file_links": {
      const data = await callContentTool<FileLinkList>(toolName, parsedArgs, callId, turnTab);
      return {
        ok: true,
        summary:
          `파일 링크 ${data.links.length}개 발견` +
          (data.omitted ? ` (그 외 ${data.omitted}개 생략)` : "") +
          (data.scriptDownloads ? `, 스크립트 다운로드 버튼 ${data.scriptDownloads}개(읽기 불가)` : "") +
          ".",
        data,
      };
    }
    case "translate_page": {
      const data = await callContentTool<{
        translatedNodes: number;
        scheduledNodes?: number;
        inProgress?: boolean;
        perRoot?: Array<{ name: string; collected: number }>;
        totalCollected?: number;
      }>(toolName, parsedArgs, callId, turnTab);
      const breakdown = data.perRoot?.length
        ? " [" +
          data.perRoot
            .filter((d) => d.collected > 0)
            .map((d) => `${truncate(d.name, 40)}:${d.collected}`)
            .join(", ") +
          "]"
        : "";
      const collectedHint =
        typeof data.totalCollected === "number" && data.totalCollected !== data.translatedNodes
          ? ` (수집 ${data.totalCollected})`
          : "";
      const progressSummary = data.inProgress
        ? `첫 배치 ${data.translatedNodes}개 적용, 나머지 ${data.scheduledNodes ?? 0}개 백그라운드 번역 중`
        : `페이지 내 ${data.translatedNodes}개 텍스트 노드 번역 완료`;
      return {
        ok: true,
        summary: `${progressSummary}${collectedHint}.${breakdown}`,
        data,
      };
    }
    case "sign_in": {
      // 승인 판정에서 정한 항목(execArgs.uuid)만 쓴다. 모델 인자에는 항목이 없다.
      const { uuid, token } = parsedArgs as { uuid?: unknown; token?: unknown };
      if (typeof uuid !== "string" || !uuid || typeof token !== "string") throw new Error("넣을 비밀번호 관리자 항목을 정하지 못했습니다.");
      return runSignIn(token, uuid, turnTab, signal);
    }
    case "find_form_fields": {
      const data = await callContentTool<FormField[]>(toolName, parsedArgs, callId, turnTab);
      return {
        ok: true,
        summary: `입력 필드 ${data.length}개 발견.`,
        data,
      };
    }
    case "fill_form_fields": {
      const data = await callContentTool<{
        filledCount: number;
        results: Array<{ id: string; label: string; applied: boolean; note?: string }>;
      }>(toolName, parsedArgs, callId, turnTab);
      const failed = data.results.filter((r) => !r.applied);
      const failNote = failed.length
        ? ` 반영 안 됨 ${failed.length}개: ${failed
            .slice(0, 3)
            .map((r) => `${r.label || r.id}(${truncate(r.note ?? "", 60)})`)
            .join(", ")}`
        : "";
      return {
        ok: data.filledCount > 0,
        summary: `${data.results.length}개 중 ${data.filledCount}개 칸에 값이 반영됐습니다.${failNote}`,
        data,
      };
    }
    case "list_page_images": {
      const data = await callContentTool<PageImage[]>(toolName, parsedArgs, callId, turnTab);
      return {
        ok: true,
        summary: `이미지 ${data.length}개 발견.`,
        data,
      };
    }
    case "download_images":
    case "download_files": {
      const args = parsedArgs as ToolArgs["download_images"] | ToolArgs["download_files"];
      const kind = toolName === "download_images" ? "image" : "file";
      // 늘 미리보기(카드·허락 판정)를 거치고, 미리보기가 확정한 폴더(execArgs)로 온다.
      // 실행부는 설정을 다시 읽지 않는다(그 사이 설정이 바뀌어도 확인한 폴더에 저장).
      const folder = args.folderPrefix || DEFAULT_DOWNLOAD_FOLDER;
      // 받는 것은 카드에서 고른(허락 경로면 모델이 넘긴) 고정 후보뿐이다. 모델 인자의 주소는 다시 쓰지 않는다.
      const picked = takeChosenDownloads(callId, kind);
      if (!picked.length) throw new Error("고른 항목이 없어 저장하지 않았습니다.");
      const urls = picked.map((p) => p.url);
      // 이번 대화 허락으로 실행하는 호출은 그 호출을 위해 쿠키 없이 미리 받은 이미지만 저장한다(grantImages.ts).
      // 미리 받은 것이 없으면 원본 주소로 내려받지 않고 실패한다(fail-closed, imageDownloadSources).
      // 첨부 파일은 허락 대상이 아니라 viaGrant로 오지 않지만, 오더라도 같은 판정으로 실패한다.
      const sources = imageDownloadSources(urls, opts.viaGrant === true, opts.grantImages);
      if ("error" in sources) throw new Error(sources.error);
      const labels = new Map(picked.map((p) => [p.url, p.label]));
      const res = await runDownloads(
        kind,
        sources.map((s) => ({ ...s, label: labels.get(s.url) ?? "" })),
        folder,
        signal,
      );
      return {
        ok: res.savedCount > 0,
        summary: downloadSummary(res),
        data: { ...res, location: `브라우저 다운로드 폴더 아래 '${res.folder}/'` },
      };
    }
    case "capture_page": {
      const args = parsedArgs as ToolArgs["capture_page"] & { approvedTarget?: CaptureTarget };
      // 늘 미리보기(카드)를 거치고, 미리보기가 확정한 폴더와 승인한 대상(execArgs)으로 온다. 대상이 없으면 찍지 않는다.
      const approved = args.approvedTarget;
      if (!approved) throw new Error("승인한 캡처 대상이 없어 캡처하지 않았습니다.");
      const folder = args.folderPrefix || DEFAULT_DOWNLOAD_FOLDER;
      const data = args.fullPage
        ? await captureFullPage(turnTab, callId, folder, approved, signal)
        : await captureVisible(turnTab, folder, approved, signal);
      return { ok: data.savedCount > 0, summary: captureSummary(data), data };
    }
    case "query_dom": {
      const qa = parsedArgs as ToolArgs["query_dom"];
      // 디버그 로그에 선택자를 남긴다(#156). 모델이 만든 인자만 — 입력 칸 값은 없다.
      debugLog("tool:query_dom:args", `selector='${truncate(qa.selector, 120)}'${qa.attr ? ` attr=${qa.attr}` : ""}`);
      const data = await callContentTool<Array<{ text: string; attrs: Record<string, string> }>>(
        toolName,
        parsedArgs,
        callId,
        turnTab,
      );
      return {
        ok: true,
        summary: `선택자 결과 ${data.length}개.`,
        data,
      };
    }
    case "navigate_to_url": {
      const args = parsedArgs as ToolArgs["navigate_to_url"];
      const url = normalizeNavigationUrl(args.url);
      const { leftPopup, note } = await navigateOriginalTab(url, turnTab, signal);
      return {
        ok: true,
        summary: `${leftPopup ? "팝업 창 따라가기를 멈추고 원래 탭 " : "현재 탭 "}이동 시작: ${truncate(url, 100)}`,
        data: leftPopup ? { url, note } : { url },
      };
    }
    case "open_saved_link": {
      // 미리보기가 저장 링크로 만든 주소(execArgs.url)만 쓴다. 승인 카드에 보인 주소와 같다.
      const args = parsedArgs as ToolArgs["open_saved_link"] & { url?: string };
      if (!args.url) throw new Error("저장한 링크 주소를 만들지 못했습니다.");
      const link = await savedLinkById(args.id);
      if (signal?.aborted) throw new Error("중단되어 저장한 링크를 열지 않았습니다.");
      const { leftPopup, note } = await navigateOriginalTab(args.url, turnTab, signal);
      await markUsed(link.id).catch(() => {});
      return {
        ok: true,
        summary: `저장한 링크 '${truncate(link.name, 40)}' 열기 시작: ${truncate(args.url, 100)}`,
        data: leftPopup ? { url: args.url, link: link.name, note } : { url: args.url, link: link.name },
      };
    }
    case "find_clickables": {
      const args = parsedArgs as ToolArgs["find_clickables"];
      // 디버그 로그에 찾기 조건을 남긴다(#152). 모델이 만든 인자만 — 입력 칸 값은 들어 있지 않다.
      debugLog(
        "tool:find_clickables:args",
        [
          args.query ? `query='${truncate(args.query, 40)}'` : "",
          args.region ? `region=${args.region}` : "",
          args.onlyViewport ? "onlyViewport" : "",
        ].filter(Boolean).join(" ") || "조건 없음",
      );
      const { items, unfiltered } = await callContentTool<{ items: ClickableElement[]; unfiltered: number }>(
        toolName,
        parsedArgs,
        callId,
        turnTab,
      );
      // 찾기 조건 때문에 0개면 조건 없이 찾은 수를 알려 모델이 바로 조건을 넓히게 한다(#151).
      if (!items.length && unfiltered > 0) {
        return {
          ok: true,
          summary: `클릭 가능 요소 0개 발견(조건 없이 ${unfiltered}개).`,
          data: {
            items,
            note: `찾기 조건(query·region·onlyViewport)에 맞는 요소가 없습니다. 조건 없이 찾으면 클릭 가능 요소가 ${unfiltered}개 있습니다. query는 화면 글자에 그대로 들어 있어야 맞으니 낱말을 짧게 줄이거나 '|'로 다른 표현을 더하고, 그래도 없으면 조건을 빼고 다시 찾으세요.`,
          },
        };
      }
      return {
        ok: true,
        summary: `클릭 가능 요소 ${items.length}개 발견.`,
        data: items,
      };
    }
    case "click_element":
      return clickTool(parsedArgs, callId, turnTab, signal, opts);
    case "google_sheets_list": {
      const args = parsedArgs as ToolArgs["google_sheets_list"];
      const data = await listSheets(args.spreadsheetId);
      return {
        ok: true,
        summary: `'${truncate(data.title, 50)}' — 시트 ${data.sheets.length}개`,
        data,
      };
    }
    case "google_sheets_read_range": {
      const args = parsedArgs as ToolArgs["google_sheets_read_range"];
      const data = await readRange(args.spreadsheetId, args.range);
      const rows = data.values.length;
      const cols = Math.max(0, ...data.values.map((r) => r.length));
      return {
        ok: true,
        summary: `${data.range} 읽음 · ${rows}×${cols}`,
        data,
      };
    }
    case "google_sheets_write_range": {
      const args = parsedArgs as ToolArgs["google_sheets_write_range"];
      const data = await writeRange(args.spreadsheetId, args.range, args.values);
      return {
        ok: true,
        summary: `${args.range}에 ${data.updatedCells}개 셀 기록`,
        data,
      };
    }
    case "google_sheets_append_rows": {
      const args = parsedArgs as ToolArgs["google_sheets_append_rows"];
      const data = await appendRows(args.spreadsheetId, args.range, args.values);
      return {
        ok: true,
        summary: `${data.appendedRows}행 추가 (${data.updatedRange})`,
        data,
      };
    }
    case "google_sheets_write_markdown_table": {
      const args = parsedArgs as ToolArgs["google_sheets_write_markdown_table"];
      const values = parseMarkdownTable(args.markdownTable);
      const data = await writeRange(args.spreadsheetId, args.range, values);
      return {
        ok: true,
        summary: `markdown 표 (${values.length}행) → ${args.range}, ${data.updatedCells}셀 기록`,
        data,
      };
    }
    case "google_drive_search": {
      const args = parsedArgs as ToolArgs["google_drive_search"];
      const data = await searchFiles(args.query, args.maxResults ?? 20);
      return {
        ok: true,
        summary: `검색 결과 ${data.length}개`,
        data,
      };
    }
    case "google_drive_list_recent": {
      const args = parsedArgs as ToolArgs["google_drive_list_recent"];
      const data = await listRecent(args.mimeType, args.maxResults ?? 20);
      return {
        ok: true,
        summary: `최근 파일 ${data.length}개`,
        data,
      };
    }
    case "google_drive_export": {
      const args = parsedArgs as ToolArgs["google_drive_export"];
      const data = await exportFile(
        args.fileId,
        args.format,
        args.maxChars ?? 20_000,
      );
      return {
        ok: true,
        summary: `${args.format} export · ${data.bytes} bytes${data.truncated ? " · 잘림" : ""}`,
        data,
      };
    }
    case "confirm_task":
      // 작업 맡기기 카드는 대화 객체(ChatAgent.confirmTask)가 직접 처리한다.
      throw new Error("confirm_task는 실행 도구가 아닙니다.");
    case "schedule_repeat_task":
      // 반복 작업 등록 카드는 대화 객체(ChatAgent.scheduleRepeat)가 직접 처리한다(#138).
      throw new Error("schedule_repeat_task는 실행 도구가 아닙니다.");
  }
}
