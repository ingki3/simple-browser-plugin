// 음성 입력(#184): 패널이 녹음한 WAV를 사용자가 고른 전용 음성 모델로 글자로 바꾼다. 패널마다 포트 하나, 포트에 작업이 묶인다.
// 녹음을 시작할 때(begin) 보낼 곳(제공자·모델·언어)을 고정하고, 보내기 직전과 보내는 동안 설정이 그것과 달라지면 보내지 않거나
// 멈춘다(화면에서 확인한 곳으로만 보낸다). 녹음 데이터는 메모리에만 두고 로그·저장하지 않는다.
import { SETTINGS_KEY } from "@/lib/messages";
import {
  VOICE_LABELS,
  VOICE_MAX_SECONDS,
  VOICE_MIN_SECONDS,
  VOICE_TIMEOUT_MS,
  base64ToBytes,
  buildVoiceRequest,
  finishVoiceText,
  isVoiceProvider,
  parseVoiceResponse,
  sameTarget,
  voiceErrorMessage,
  voiceModelOf,
  wavSeconds,
  type VoiceTarget,
} from "@/lib/voice";
import type { Settings } from "@/lib/messages";
import { getSettings } from "./storage";
import { debugLog } from "./debug";

export const VOICE_PORT = "voice";

type JobState = "recording" | "sending" | "done" | "cancelled" | "failed";

interface Job {
  id: string;
  state: JobState;
  target: VoiceTarget;
  // 고정한 키(비교용, 밖으로 보내지 않음).
  apiKey: string;
  controller: AbortController | null;
  reply: (msg: Record<string, unknown>) => void;
}

const jobs = new Set<Job>();

const CHANGED = "설정이 바뀌어 보내지 않았습니다. 다시 녹음해 주세요.";

function keyFor(s: Settings, provider: VoiceTarget["provider"]): string {
  return provider === "openrouter" ? s.openRouterApiKey : (s.apiKeys[provider] ?? "");
}

// 지금 설정의 보낼 곳. 꺼짐·키 없음이면 이유.
function currentTarget(s: Settings): { target: VoiceTarget; apiKey: string } | { refused: string } {
  const v = s.voiceInput;
  if (!isVoiceProvider(v.provider)) return { refused: "설정 → 음성 입력에서 음성을 바꿀 모델을 고르세요." };
  const apiKey = keyFor(s, v.provider);
  if (!apiKey) return { refused: `${VOICE_LABELS[v.provider]} API 키가 없습니다. 설정 → 음성 입력에서 키를 넣으세요.` };
  return { target: { provider: v.provider, model: voiceModelOf(v, v.provider), language: v.language }, apiKey };
}

function stillSame(job: Job, s: Settings): boolean {
  const now = currentTarget(s);
  return "target" in now && sameTarget(now.target, job.target) && now.apiKey === job.apiKey;
}

function cancelJob(job: Job, state: JobState = "cancelled"): void {
  if (job.state === "done" || job.state === "cancelled" || job.state === "failed") return;
  job.state = state;
  job.controller?.abort();
}

// 설정이 바뀌면 진행 중인 작업이 아직 같은 곳으로 보내는지 다시 본다. 달라졌으면 멈추고 패널에 알린다(녹음 중이어도).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[SETTINGS_KEY] || !jobs.size) return;
  void getSettings().then((s) => {
    for (const job of jobs) {
      if ((job.state === "recording" || job.state === "sending") && !stillSame(job, s)) {
        cancelJob(job, "failed");
        job.reply({ kind: "error", jobId: job.id, message: CHANGED, changed: true });
      }
    }
  });
});

async function transcribe(job: Job, audio: unknown): Promise<{ text: string; truncated: boolean }> {
  if (job.state !== "recording") throw new Error("이미 보냈거나 취소한 녹음입니다.");
  const wav = base64ToBytes(audio);
  if (!wav) throw new Error("녹음이 너무 크거나 형식이 맞지 않습니다.");
  const seconds = wavSeconds(wav);
  if (seconds === null) throw new Error("녹음 형식이 맞지 않습니다.");
  if (seconds < VOICE_MIN_SECONDS) throw new Error("녹음이 너무 짧습니다.");
  if (seconds > VOICE_MAX_SECONDS + 1) throw new Error(`녹음은 ${VOICE_MAX_SECONDS}초까지입니다.`);
  job.state = "sending";
  // 첫 await 전에 만든다: 설정 확인을 기다리는 사이 취소가 와도 이 신호가 멈춘다.
  const controller = new AbortController();
  job.controller = controller;
  const alive = () => {
    if (job.state !== "sending" || controller.signal.aborted) throw new Error("취소했습니다.");
  };
  const settings = await getSettings();
  alive();
  if (!stillSame(job, settings)) {
    cancelJob(job, "failed");
    throw new Error(CHANGED);
  }
  const req = buildVoiceRequest(job.target, job.apiKey, wav, audio as string);
  const timer = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: controller.signal });
    alive();
    const json: unknown = await res.json().catch(() => null);
    alive();
    if (!res.ok) throw new Error(voiceErrorMessage(res.status, json));
    const text = parseVoiceResponse(job.target.provider, json);
    if (text === null) throw new Error("음성 변환 응답을 읽지 못했습니다.");
    const out = finishVoiceText(text);
    debugLog("voice:transcribe", `${job.target.provider} · ${job.target.model} · ${seconds.toFixed(1)}s · ${out.text.length}자 · ${Date.now() - t0}ms`);
    return out;
  } catch (err) {
    if (controller.signal.aborted && job.state === "sending") throw new Error(`음성 변환이 ${VOICE_TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 패널의 음성 포트. 포트마다 작업 하나(새로 시작하면 이전 작업은 취소), 끊기면 취소.
export function handleVoicePort(port: chrome.runtime.Port): void {
  let job: Job | null = null;
  // 가장 최근에 시작한 begin(설정을 읽는 사이 새 begin이 오면 앞의 것은 만들지 않는다).
  let latestBegin = "";
  const reply = (msg: Record<string, unknown>) => {
    try {
      port.postMessage(msg);
    } catch {
      /* 포트가 닫힘 */
    }
  };
  const drop = () => {
    if (job) {
      cancelJob(job);
      jobs.delete(job);
    }
    job = null;
  };
  port.onMessage.addListener((raw: unknown) => {
    const m = (raw ?? {}) as { kind?: unknown; jobId?: unknown; audio?: unknown };
    const jobId = typeof m.jobId === "string" && m.jobId.length <= 64 ? m.jobId : "";
    if (!jobId) return;
    if (m.kind === "begin") {
      drop();
      latestBegin = jobId;
      void getSettings().then((s) => {
        // 그 사이 다른 begin·취소가 왔으면 이 작업은 만들지 않는다.
        if (latestBegin !== jobId) return;
        const now = currentTarget(s);
        if ("refused" in now) {
          reply({ kind: "refused", jobId, message: now.refused });
          return;
        }
        const mine: Job = { id: jobId, state: "recording", target: now.target, apiKey: now.apiKey, controller: null, reply };
        job = mine;
        jobs.add(mine);
        reply({ kind: "ready", jobId, provider: now.target.provider, label: VOICE_LABELS[now.target.provider], model: now.target.model });
      });
      return;
    }
    if (m.kind === "cancel" && latestBegin === jobId) latestBegin = "";
    const mine = job;
    if (!mine || mine.id !== jobId) {
      if (m.kind === "transcribe") reply({ kind: "error", jobId, message: "녹음 작업이 없습니다. 다시 녹음해 주세요." });
      return;
    }
    if (m.kind === "cancel") {
      drop();
      return;
    }
    if (m.kind === "transcribe") {
      transcribe(mine, m.audio).then(
        (out) => {
          if (mine.state !== "sending") return;
          mine.state = "done";
          jobs.delete(mine);
          if (job === mine) job = null;
          reply({ kind: "text", jobId, ...out });
        },
        (err: unknown) => {
          const wasLive = mine.state === "sending" || mine.state === "recording";
          if (mine.state !== "cancelled") mine.state = "failed";
          jobs.delete(mine);
          if (job === mine) job = null;
          // 취소한 작업의 늦은 오류는 보내지 않는다. 설정 변경 알림은 이미 보냈으면 다시 보내지 않는다.
          const msg = err instanceof Error ? err.message : String(err);
          if (wasLive || msg === CHANGED) reply({ kind: "error", jobId, message: msg });
        },
      );
    }
  });
  port.onDisconnect.addListener(() => {
    latestBegin = "";
    drop();
  });
}
