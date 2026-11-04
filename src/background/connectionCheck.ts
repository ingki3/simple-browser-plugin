// 설정의 "연결 확인"(#129). 저장한 키·모델로 아주 짧은 요청을 한 번 보내 키와 모델이 쓰이는지 본다.
// 요청 한 번만큼 요금이 조금 든다(설정 화면에 알린다).
import { activeModel } from "@/lib/settings";
import { scrubSecret } from "@/lib/friendlyError";
import { ProviderHttpError } from "@/lib/openrouter";
import { providerAdapter } from "@/lib/providers";
import { getSettings } from "./storage";
import { debugLog } from "./debug";

const CHECK_TIMEOUT_MS = 30_000;

export async function checkConnection(): Promise<{ provider: string; model: string }> {
  const { provider, apiKey, model } = activeModel(await getSettings());
  if (!apiKey) throw new Error("저장한 API 키가 없습니다.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  debugLog("connection:check", `${provider} · ${model}`);
  try {
    await providerAdapter(provider).complete(
      apiKey,
      {
        model,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        temperature: 0,
        reasoning: "off",
        maxTokens: 64,
      },
      controller.signal,
    );
  } catch (err) {
    if (controller.signal.aborted) throw new Error("30초 안에 응답이 없습니다.");
    // 오류 원문에서 이 요청에 쓴 키를 가린다(#132 — 늦게 온 응답이어도 그 호출의 키로). 오류 종류(HTTP 상태·연결 실패)는 그대로 둔다.
    if (err instanceof ProviderHttpError) throw new ProviderHttpError(scrubSecret(err.message, apiKey), err.status);
    if (err instanceof TypeError) throw new TypeError(scrubSecret(err.message, apiKey));
    if (err instanceof Error) throw new Error(scrubSecret(err.message, apiKey));
    throw new Error(scrubSecret(String(err), apiKey));
  } finally {
    clearTimeout(timer);
  }
  return { provider, model };
}
