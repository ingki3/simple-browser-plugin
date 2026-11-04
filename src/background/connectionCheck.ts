// 설정의 "연결 확인"(#129). 저장한 키·모델로 아주 짧은 요청을 한 번 보내 키와 모델이 쓰이는지 본다.
// 요청 한 번만큼 요금이 조금 든다(설정 화면에 알린다).
import { activeModel } from "@/lib/settings";
import { scrubSecret } from "@/lib/friendlyError";
import { providerAdapter, providerTimeout } from "@/lib/providers";
import { getSettings } from "./storage";
import { debugLog } from "./debug";
import { beginTargetGuard } from "./modelTarget";
import { beginKeepalive, endKeepalive } from "./keepalive";

const CHECK_TIMEOUT_MS = 30_000;

export async function checkConnection(): Promise<{ provider: string; model: string }> {
  const active = activeModel(await getSettings());
  const { provider, model } = active;
  if (!active.ready) {
    throw new Error(active.missing === "key" ? "저장한 API 키가 없습니다." : "로컬 서버 주소와 모델을 넣어 주세요.");
  }
  const limit = providerTimeout(provider, CHECK_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  // 확인하는 사이 대상(제공자·키·모델·서버 주소)이 바뀌면 멈춘다(#193).
  const guard = beginTargetGuard(active, controller.signal);
  debugLog("connection:check", `${provider} · ${model}`);
  // 로컬 서버는 모델을 올리느라 첫 응답이 30초를 넘을 수 있다 — 기다리는 동안 서비스 워커를 붙잡는다(#193 리뷰).
  beginKeepalive();
  try {
    await guard.verify();
    await providerAdapter(provider).complete(
      active,
      {
        model,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        temperature: 0,
        reasoning: "off",
        maxTokens: 64,
      },
      guard.signal,
    );
    guard.assert();
  } catch (err) {
    guard.assert();
    if (controller.signal.aborted) throw new Error(`${Math.round(limit / 1000)}초 안에 응답이 없습니다.`);
    // 오류 원문에서 이 요청에 쓴 키를 가린다(#132 — 늦게 온 응답이어도 그 호출의 키로). 오류 종류(HTTP 상태·연결 실패)는 그대로 둔다.
    // 오류 객체를 새로 만들지 않고 글만 가린다 — 오류 종류(ProviderHttpError의 상태, 로컬 서버의 LocalOriginError 등)를 그대로 둔다.
    const apiKey = active.apiKey;
    if (err instanceof Error) {
      err.message = scrubSecret(err.message, apiKey);
      throw err;
    }
    throw new Error(scrubSecret(String(err), apiKey));
  } finally {
    clearTimeout(timer);
    guard.end();
    endKeepalive();
  }
  return { provider, model };
}
