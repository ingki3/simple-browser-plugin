import { GoogleGenAI, type Content, type FunctionCall, type Part } from "@google/genai";
import { SENSITIVE_TOOLS, type BgToPanel, type ToolName } from "@/lib/messages";
import type { ModelId } from "@/lib/models";
import { functionDeclarations } from "./tools/declarations";
import { buildToolPreview, executeTool, parseToolArgs } from "./tools/dispatcher";
import { getSettings } from "./storage";
import { beginKeepalive, endKeepalive } from "./keepalive";
import { debugLog, timeSpan } from "./debug";
import { detectPdfAtActiveTab, fetchPdfAsBase64 } from "./pdf";

const SYSTEM_PROMPT = `너는 Chrome 사이드 패널에서 사용자의 현재 탭을 돕는 한국어 에이전트다.
동작 방식은 ReAct 패턴을 따른다: 생각(Thought) → 행동(Action, 툴 호출) → 관측(Observation, 툴 결과) → 다시 생각 → … → 최종 답.

절대 규칙:
1. 페이지와 상호작용하거나 페이지 내용을 근거로 말해야 하는 요청은, 어떤 조작 툴(find_clickables, click_element, fill_form_fields, download_images, translate_page, list_page_images, find_form_fields 등)보다 먼저 describe_page를 호출해 페이지를 관측한다. 같은 대화에서 방금 describe_page 결과를 본 직후라면 다시 부르지 않는다.
2. 모든 툴 호출 직전에 짧은 Thought를 텍스트로 먼저 말한다. Thought는 다음을 포함한다:
   (a) 관측 결과에 근거한 현재 페이지의 성격(어떤 종류의 사이트/화면으로 보이는지, 주요 랜드마크는 무엇인지).
   (b) 사용자의 요청이 이 페이지 맥락에서 구체적으로 무엇을 가리키는지.
   (c) 다음에 부를 툴과 그 이유.
3. 관측 결과가 예상과 다르거나 후보가 여러 개면 바로 행동하지 말고, Thought에서 이유를 밝힌 뒤 다른 필터/도구로 재관측하거나 사용자에게 되묻는다.
4. 민감 툴(click_element, fill_form_fields, download_images)은 실행 시 자동으로 사용자 승인 UI가 뜬다. 대상이 확정되지 않았으면 민감 툴을 부르지 말고 후보를 나열해 되묻는다.
5. 페이지 내용을 지어내지 않는다. 모르면 관측 후 말하거나 "확실하지 않다"고 말한다.
6. 툴이 ok:false로 실패하거나 에러를 반환하면:
   - 같은 툴을 같은 인자로 재시도하지 않는다.
   - Thought에서 실패 원인을 분석하고 (a) 다른 인자·다른 툴로 대안을 시도하거나, (b) 시도해 볼 만한 대안이 없으면 사용자에게 무엇이 안 됐는지 짧게 설명하고 멈춘다.
   - 특히 click_element 이후 페이지가 이동해 후속 툴이 "컨텐트 스크립트 응답이 … 오지 않았습니다" 같은 타임아웃을 내면 네비게이션이 이미 일어난 것으로 간주하고 "페이지 이동이 진행 중입니다. 새 페이지가 로드된 뒤 다시 요청해 주세요."로 사용자에게 알린다.
7. 현재 가지고 있는 툴로 할 수 없는 작업(예: 페이지 스크롤, 복잡한 편집, 외부 API 호출, 탭 열기·닫기 등)은 지원 범위를 밝히고 불가능함을 말한다. 억지로 다른 툴을 조합하지 않는다.

describe_page 결과를 읽는 법:
- landmarks 배열: region(main/article/nav/aside/header/footer) 별로 textPreview(본문 요약)와 sampleClickables(대표 링크·버튼). 어떤 region이 본문 컨텐츠를 담고 있는지, 어떤 region이 사이트 크롬(메뉴, 툴바)인지 여기서 판단한다.
- headings: 페이지 주제 파악용 표제 목록.
- fallbackExcerpt: 시맨틱 랜드마크가 거의 없는 페이지일 때만 채워지는 본문 일부. 이때는 이 문자열이 주 단서다.

대상 해석 원칙:
- 사용자의 지시어(예: "아티클", "글", "항목", "첫 번째", "그 버튼")는 페이지 맥락에서 의미가 달라진다. 관측에서 본 textPreview·headings·sampleClickables를 근거로 어떤 요소를 가리키는지 추론한다.
- 본문·컨텐츠를 가리키는 말이면 main/article region 후보를 우선한다. 네비게이션·사이드바·툴바를 가리키는 말이면 nav/header/aside/footer 후보를 본다. 사용자가 명시적으로 한쪽을 지목하지 않았으면 본문 쪽이 기본.
- "첫 번째/두 번째" 등 순서 표현은 좁혀진 후보 배열의 인덱스로 해석한다. 후보가 애매하면 몇 개를 짧게 나열해 되묻는다.
- 현재 화면에 보이는 것으로 보이는 요청이면 find_clickables의 onlyViewport=true를 활용한다.

툴 카탈로그:
- describe_page: 페이지 관측. 상호작용 전 1차 툴.
- get_page_content: 본문 텍스트 전체 추출 (요약·질의응답 근거 보강).
- find_clickables(query?, region?, onlyViewport?): 클릭 후보 탐색. region/query/onlyViewport로 좁힌다.
- click_element(id): 민감. id는 반드시 find_clickables에서 얻은 값.
- find_form_fields / fill_form_fields: 입력 필드 탐색 → 채우기(민감).
- list_page_images / download_images: 이미지 목록 → 저장(민감).
- translate_page: 페이지 전체 번역.
- query_dom: 위 도구들로 해결 안 되는 특정 CSS 선택자 조회.

일반 규칙:
- 페이지와 무관한 잡담·일반 번역·개념 질문은 툴 없이 바로 답한다.
- 한국어 우선. 간결하게. 마크다운을 과도하게 쓰지 않는다.

PDF 모드:
- 사용자 턴에 PDF가 inlineData로 첨부되어 있거나 "[현재 탭: PDF 문서]" 문구가 있으면, 현재 화면은 Chrome의 내장 PDF 뷰어다.
- 이 경우 describe_page·find_clickables·fill_form_fields·translate_page 등 페이지 조작 도구는 동작하지 않거나 의미가 없다. 이런 도구를 호출하지 말고, 첨부된 PDF 내용을 직접 읽어 답한다.
- 사용자가 "번역해줘" 같은 요청을 하면 PDF 본문 텍스트를 한국어로 정리해 답변으로 제공한다 (실제 PDF를 수정할 수 없음).
- PDF가 로드 실패 문구가 있으면 그 사실을 알리고 수동 업로드나 다른 방법을 제안한다.`;

export class ChatAgent {
  private history: Content[] = [];
  private apiKey: string | null = null;
  private model: ModelId | null = null;
  private aborted = false;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private lastAttachedPdfUrl: string | null = null;

  constructor(private readonly port: chrome.runtime.Port) {}

  abort(): void {
    this.aborted = true;
    for (const resolve of this.pendingApprovals.values()) resolve(false);
    this.pendingApprovals.clear();
  }

  approveTool(callId: string): void {
    this.pendingApprovals.get(callId)?.(true);
  }

  cancelTool(callId: string): void {
    this.pendingApprovals.get(callId)?.(false);
  }

  reset(): void {
    this.history = [];
    this.aborted = false;
    this.lastAttachedPdfUrl = null;
  }

  private send(msg: BgToPanel): void {
    try {
      this.port.postMessage(msg);
    } catch {
      // port closed
    }
  }

  private async ensureCredentials(): Promise<{ ai: GoogleGenAI; model: ModelId }> {
    const settings = await getSettings();
    if (!settings.apiKey) {
      throw new Error("API 키가 설정되지 않았습니다. 설정에서 키를 입력해 주세요.");
    }
    if (this.apiKey !== settings.apiKey || this.model !== settings.model) {
      this.apiKey = settings.apiKey;
      this.model = settings.model;
      this.history = [];
    }
    return { ai: new GoogleGenAI({ apiKey: settings.apiKey }), model: settings.model };
  }

  private async fetchTabHeader(): Promise<string> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return "";
      const url = tab.url ?? "";
      const title = tab.title ?? "";
      if (!url && !title) return "";
      return `[탭 메타데이터 — 상세 내용은 describe_page로 관측하세요]\nURL: ${url}\n제목: ${title}`;
    } catch {
      return "";
    }
  }

  private async buildUserParts(userText: string): Promise<Part[]> {
    const pdfInfo = await detectPdfAtActiveTab();

    if (pdfInfo?.isPdf) {
      const alreadyAttached = pdfInfo.url === this.lastAttachedPdfUrl;
      if (alreadyAttached) {
        debugLog("pdf:already_attached", pdfInfo.url);
        return [
          {
            text: `[현재 탭: 첨부된 PDF — ${pdfInfo.url}]\n\n[사용자 요청]\n${userText}`,
          },
        ];
      }
      debugLog("pdf:fetch", pdfInfo.url);
      this.send({ kind: "status", text: "PDF 문서 불러오는 중…" });
      const endFetch = timeSpan("pdf:fetch");
      try {
        const { data, bytes } = await fetchPdfAsBase64(pdfInfo.url);
        endFetch(`${Math.round(bytes / 1024)}KB`);
        this.lastAttachedPdfUrl = pdfInfo.url;
        return [
          { inlineData: { mimeType: "application/pdf", data } },
          {
            text: `[현재 탭: PDF 문서 — ${pdfInfo.url}]\n이 대화에서는 페이지 조작 도구(translate_page, find_clickables 등)는 사용할 수 없고, 첨부된 PDF 내용을 직접 읽고 답한다.\n\n[사용자 요청]\n${userText}`,
          },
        ];
      } catch (err) {
        endFetch("fail");
        const msg = err instanceof Error ? err.message : String(err);
        debugLog("pdf:error", msg, "warn");
        return [
          {
            text: `[현재 탭: PDF ${pdfInfo.url} — 자동 로드 실패: ${msg}]\n\n[사용자 요청]\n${userText}`,
          },
        ];
      }
    }

    // Normal web page
    const header = await this.fetchTabHeader();
    const composed = header ? `${header}\n\n[사용자 요청]\n${userText}` : userText;
    return [{ text: composed }];
  }

  async sendUserTurn(userText: string): Promise<void> {
    this.aborted = false;
    beginKeepalive();
    const endTurn = timeSpan("turn");
    try {
      const { ai, model } = await this.ensureCredentials();
      debugLog("turn:model", model);

      const userParts = await this.buildUserParts(userText);
      this.history.push({ role: "user", parts: userParts });

      await this.streamLoop(ai, model);
      endTurn("ok");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog("turn:error", msg, "error");
      endTurn("fail");
      this.send({ kind: "error", message: msg });
    } finally {
      endKeepalive();
    }
  }

  private async streamLoop(ai: GoogleGenAI, model: ModelId): Promise<void> {
    const { maxToolHops } = await getSettings();
    for (let hop = 0; hop < maxToolHops; hop += 1) {
      if (this.aborted) return;
      debugLog("hop:start", `#${hop + 1}/${maxToolHops}`);

      const CONNECT_TIMEOUT_MS = 20_000;
      const streamPromise = ai.models.generateContentStream({
        model,
        contents: this.history,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations }],
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: -1,
          },
        },
      });
      const stream = await Promise.race([
        streamPromise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Gemini 연결이 ${Math.round(CONNECT_TIMEOUT_MS / 1000)}초 안에 열리지 않았습니다. 네트워크 상태나 API 키를 확인하고 다시 시도해 주세요.`,
                ),
              ),
            CONNECT_TIMEOUT_MS,
          ),
        ),
      ]);

      debugLog("stream:connected");
      const aggregatedParts: Part[] = [];
      const functionCalls: FunctionCall[] = [];
      let chunkCount = 0;
      let textChars = 0;
      let thoughtChars = 0;
      let finishReason: string | undefined;

      const INACTIVITY_MS = 60_000;
      const iter = stream[Symbol.asyncIterator]();

      while (true) {
        if (this.aborted) return;

        const timeoutMarker = Symbol("inactivity");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<typeof timeoutMarker>((resolve) => {
          timer = setTimeout(() => resolve(timeoutMarker), INACTIVITY_MS);
        });

        let step: IteratorResult<unknown> | typeof timeoutMarker;
        try {
          step = await Promise.race([iter.next(), timeoutPromise]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }

        if (step === timeoutMarker) {
          try {
            await iter.return?.(undefined);
          } catch {
            /* ignore */
          }
          throw new Error(
            `Gemini 응답이 ${Math.round(INACTIVITY_MS / 1000)}초 동안 오지 않아 중단했습니다. 네트워크 상태나 Gemini 서버 상태를 확인하고 다시 시도해 주세요.`,
          );
        }

        const result = step as IteratorResult<Awaited<ReturnType<typeof iter.next>>["value"]>;
        if (result.done) break;
        const chunk = result.value as {
          candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
        };

        chunkCount += 1;
        const content = chunk.candidates?.[0]?.content;
        if (content?.parts) {
          for (const part of content.parts) {
            aggregatedParts.push(part);
            if (part.functionCall) {
              functionCalls.push(part.functionCall as FunctionCall);
              const argsStr = (() => {
                try {
                  const s = JSON.stringify(part.functionCall.args ?? {});
                  return s.length > 200 ? s.slice(0, 197) + "…" : s;
                } catch {
                  return "<unserializable>";
                }
              })();
              debugLog(
                "stream:functionCall",
                `${part.functionCall.name ?? "?"} ${argsStr}`,
              );
              this.send({
                kind: "status",
                text: `도구 호출: ${part.functionCall.name}`,
              });
            }
            if (typeof part.text === "string" && part.text.length > 0) {
              if (part.thought) {
                thoughtChars += part.text.length;
                this.send({ kind: "thought_chunk", text: part.text });
              } else {
                textChars += part.text.length;
                this.send({ kind: "assistant_chunk", text: part.text });
              }
            }
          }
        }

        const fr = chunk.candidates?.[0]?.finishReason;
        if (fr) finishReason = String(fr);
      }
      debugLog(
        "stream:done",
        `chunks=${chunkCount} text=${textChars} thought=${thoughtChars} fn=${functionCalls.length} finish=${finishReason ?? "?"}`,
      );

      if (aggregatedParts.length > 0) {
        this.history.push({ role: "model", parts: aggregatedParts });
      }

      if (functionCalls.length === 0) {
        this.send({ kind: "status", text: null });
        this.send({ kind: "assistant_done", finishReason });
        return;
      }

      const responseParts: Part[] = [];
      for (const fc of functionCalls) {
        const toolName = fc.name as ToolName;
        const callId = crypto.randomUUID();

        let parsedArgs: unknown;
        try {
          parsedArgs = parseToolArgs(toolName, fc.args as unknown);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.send({ kind: "tool_result", callId, toolName, ok: false, summary: msg });
          responseParts.push({
            functionResponse: { name: toolName, response: { error: msg } },
          });
          continue;
        }

        if (SENSITIVE_TOOLS.has(toolName)) {
          const preview = await buildToolPreview(toolName, parsedArgs);
          debugLog("tool:awaiting_approval", `${toolName}`);
          this.send({
            kind: "tool_pending",
            callId,
            toolName,
            args: parsedArgs,
            previewSummary: preview.summary,
            previewDetails: preview.details,
          });
          const approved = await new Promise<boolean>((resolve) => {
            this.pendingApprovals.set(callId, resolve);
          });
          this.pendingApprovals.delete(callId);
          debugLog(
            "tool:approval_result",
            `${toolName} ${approved ? "approved" : "cancelled"}`,
          );

          if (!approved) {
            this.send({
              kind: "tool_result",
              callId,
              toolName,
              ok: false,
              summary: "사용자가 취소했습니다.",
            });
            responseParts.push({
              functionResponse: {
                name: toolName,
                response: { error: "user_cancelled" },
              },
            });
            continue;
          }
        }

        try {
          const result = await executeTool(toolName, parsedArgs, callId);
          debugLog(
            "tool:result",
            `${toolName} ${result.ok ? "ok" : "fail"} · ${result.summary.slice(0, 140)}`,
          );
          this.send({
            kind: "tool_result",
            callId,
            toolName,
            ok: result.ok,
            summary: result.summary,
          });
          responseParts.push({
            functionResponse: {
              name: toolName,
              response: { result: result.data },
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.send({ kind: "tool_result", callId, toolName, ok: false, summary: msg });
          responseParts.push({
            functionResponse: { name: toolName, response: { error: msg } },
          });
        }
      }

      this.history.push({ role: "user", parts: responseParts });
    }

    this.send({
      kind: "error",
      message: `도구 호출 순환 한도(${maxToolHops})에 도달했습니다.`,
    });
  }
}
