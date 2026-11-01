import { useCallback, useEffect, useRef, useState } from "react";
import { VOICE_MAX_SECONDS, VOICE_MIN_SECONDS, VOICE_SAMPLE_RATE, bytesToBase64, encodeWav } from "@/lib/voice";

// 음성 입력(#184) 녹음 훅. 녹음을 시작할 때 백그라운드가 보낼 곳(제공자·모델)을 고정해 알려 주고(begin → ready), 멈추면
// 16kHz 모노 WAV로 바꿔 보낸다(transcribe). 바뀐 글자는 onText로만 넘긴다(입력창에 넣는 일은 부르는 쪽, 자동으로 보내지 않음).
// 세대 번호(gen): 새 대화·취소·패널 닫힘마다 올린다. 늦게 끝난 권한 요청·녹음 콜백·변환 결과는 세대가 다르면 버린다.

export type VoiceState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "recording"; seconds: number; label: string; model: string }
  | { phase: "transcribing"; label: string }
  | { phase: "error"; message: string; settings?: boolean };

const SILENCE_RMS = 0.015;
const SILENCE_MS = 2000;
const TICK_MS = 100;

interface Live {
  gen: number;
  jobId: string;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  ctx: AudioContext | null;
  timer: number;
  // 멈춤은 한 번만(수동·60초·무음이 겹쳐도).
  stopping: boolean;
  label: string;
}

type PortMsg =
  | { kind: "ready"; jobId: string; label: string; model: string }
  | { kind: "refused"; jobId: string; message: string }
  | { kind: "text"; jobId: string; text: string; truncated: boolean }
  | { kind: "error"; jobId: string; message: string; changed?: boolean };

export function useVoiceInput(opts: { conversationId: string; onText: (text: string, truncated: boolean) => void }) {
  const [state, setState] = useState<VoiceState>({ phase: "idle" });
  const gen = useRef(0);
  const live = useRef<Live | null>(null);
  // begin을 보낸 뒤 녹음이 시작되기 전(권한 대기 등)의 작업. 그 사이 백그라운드가 멈추면(설정 변경) 세대를 올려 시작하지 않게.
  const pending = useRef<{ gen: number; jobId: string } | null>(null);
  const port = useRef<chrome.runtime.Port | null>(null);
  // jobId별 begin 응답을 기다리는 곳.
  const waiters = useRef(new Map<string, (m: PortMsg) => void>());
  const onTextRef = useRef(opts.onText);
  onTextRef.current = opts.onText;

  const release = (l: Live) => {
    window.clearInterval(l.timer);
    for (const t of l.stream?.getTracks() ?? []) t.stop();
    void l.ctx?.close().catch(() => {});
    l.ctx = null;
  };

  const getPort = (): chrome.runtime.Port => {
    if (port.current) return port.current;
    const p = chrome.runtime.connect({ name: "voice" });
    p.onMessage.addListener((raw: unknown) => {
      const m = raw as PortMsg;
      if (!m || typeof m !== "object" || typeof m.jobId !== "string") return;
      const w = waiters.current.get(m.jobId);
      if (w) {
        waiters.current.delete(m.jobId);
        w(m);
        return;
      }
      // 녹음을 시작하기 전(권한 대기 중) 설정이 바뀌어 백그라운드가 멈춘 경우: 시작하지 않게 세대를 올린다.
      const pend = pending.current;
      if (m.kind === "error" && pend && pend.jobId === m.jobId && !live.current) {
        pending.current = null;
        gen.current += 1;
        setState({ phase: "error", message: m.message });
        return;
      }
      // 녹음 중 설정이 바뀌어 백그라운드가 멈춘 경우 등: 지금 작업이면 녹음을 버리고 알린다.
      const l = live.current;
      if (!l || l.jobId !== m.jobId) return;
      if (m.kind === "error") {
        stopRecording(l, "discard");
        live.current = null;
        gen.current += 1;
        setState({ phase: "error", message: m.message });
      }
    });
    p.onDisconnect.addListener(() => {
      port.current = null;
      // 권한 대기 중(녹음 전)이면 백그라운드 작업이 사라졌으니 시작하지 않게 한다.
      if (pending.current && !live.current) {
        pending.current = null;
        gen.current += 1;
        setState({ phase: "error", message: "백그라운드와 연결이 끊겼습니다. 다시 눌러 주세요." });
      }
      for (const w of waiters.current.values()) w({ kind: "error", jobId: "", message: "백그라운드와 연결이 끊겼습니다. 다시 눌러 주세요." });
      waiters.current.clear();
      const l = live.current;
      if (l) {
        stopRecording(l, "discard");
        live.current = null;
        gen.current += 1;
        setState({ phase: "error", message: "백그라운드와 연결이 끊겼습니다. 다시 눌러 주세요." });
      }
    });
    port.current = p;
    return p;
  };

  const post = (msg: Record<string, unknown>) => {
    try {
      getPort().postMessage(msg);
    } catch {
      /* 다음 동작에서 다시 연결 */
    }
  };

  const ask = (msg: Record<string, unknown> & { jobId: string }): Promise<PortMsg> =>
    new Promise((resolve) => {
      waiters.current.set(msg.jobId, resolve);
      post(msg);
    });

  // 녹음 멈추기. send면 변환해 보내고, discard면 버린다(콜백에서 의도·세대를 확인).
  const stopRecording = (l: Live, intent: "send" | "discard") => {
    if (l.stopping) return;
    l.stopping = true;
    window.clearInterval(l.timer);
    const rec = l.recorder;
    if (!rec || rec.state === "inactive") {
      release(l);
      // 이미 멈춘 녹음기(장치 분리 등)를 보내려 했으면 작업을 정리하고 알린다(버튼이 막힌 채 남지 않게).
      if (intent === "send" && live.current === l) {
        live.current = null;
        post({ kind: "cancel", jobId: l.jobId });
        setState({ phase: "error", message: "녹음이 멈췄습니다. 마이크 연결을 확인하고 다시 눌러 주세요." });
      }
      return;
    }
    rec.onstop = () => {
      release(l);
      if (intent !== "send" || gen.current !== l.gen) return;
      void sendRecording(l);
    };
    rec.stop();
  };

  const sendRecording = async (l: Live) => {
    const mine = l.gen;
    setState({ phase: "transcribing", label: l.label });
    try {
      const blob = new Blob(l.chunks, { type: l.recorder?.mimeType || "audio/webm" });
      l.chunks = [];
      const samples = await toMono16k(await blob.arrayBuffer());
      if (gen.current !== mine) return;
      if (samples.length / VOICE_SAMPLE_RATE < VOICE_MIN_SECONDS || isSilent(samples)) {
        post({ kind: "cancel", jobId: l.jobId });
        live.current = null;
        setState({ phase: "error", message: "말소리가 들리지 않아 보내지 않았습니다." });
        return;
      }
      const audio = bytesToBase64(encodeWav(samples, VOICE_SAMPLE_RATE));
      if (gen.current !== mine) return;
      const res = await ask({ kind: "transcribe", jobId: l.jobId, audio });
      if (gen.current !== mine) return;
      live.current = null;
      if (res.kind === "text") {
        setState({ phase: "idle" });
        if (res.text) onTextRef.current(res.text, res.truncated);
        else setState({ phase: "error", message: "받아쓴 글자가 없습니다." });
      } else if (res.kind === "error" || res.kind === "refused") setState({ phase: "error", message: res.message });
    } catch (err) {
      if (gen.current !== mine) return;
      post({ kind: "cancel", jobId: l.jobId });
      live.current = null;
      setState({ phase: "error", message: `녹음을 바꾸지 못했습니다: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // 진행 중인 것을 모두 버린다(새 대화·취소·닫힘).
  const cancel = useCallback(() => {
    gen.current += 1;
    const pend = pending.current;
    pending.current = null;
    if (pend) post({ kind: "cancel", jobId: pend.jobId });
    const l = live.current;
    live.current = null;
    if (l) {
      stopRecording(l, "discard");
      release(l);
      post({ kind: "cancel", jobId: l.jobId });
    }
    setState({ phase: "idle" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    const mine = ++gen.current;
    const jobId = crypto.randomUUID();
    setState({ phase: "starting" });
    pending.current = { gen: mine, jobId };
    const ready = await ask({ kind: "begin", jobId });
    if (gen.current !== mine) {
      post({ kind: "cancel", jobId });
      return;
    }
    if (pending.current?.jobId === jobId && ready.kind !== "ready") pending.current = null;
    if (ready.kind !== "ready") {
      setState({ phase: "error", message: "message" in ready ? ready.message : "음성 입력을 시작하지 못했습니다.", settings: ready.kind === "refused" });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      if (gen.current !== mine) return;
      post({ kind: "cancel", jobId });
      const text = await micErrorText(err);
      // 안내를 만드는 사이(권한 조회·탭 열기) 취소·새 녹음이 됐으면 그 상태를 덮지 않는다.
      if (gen.current === mine) setState({ phase: "error", message: text });
      return;
    }
    // 권한 요청을 기다리는 사이 취소·새 대화·설정 변경이 됐으면 늦게 받은 트랙을 바로 멈춘다.
    if (pending.current?.jobId === jobId) pending.current = null;
    if (gen.current !== mine) {
      for (const t of stream.getTracks()) t.stop();
      post({ kind: "cancel", jobId });
      return;
    }
    const l: Live = { gen: mine, jobId, stream, recorder: null, chunks: [], ctx: null, timer: 0, stopping: false, label: ready.label };
    live.current = l;
    try {
      const rec = new MediaRecorder(stream);
      l.recorder = rec;
      rec.ondataavailable = (e) => {
        if (gen.current === mine && e.data.size) l.chunks.push(e.data);
      };
      // 누르지 않았는데 멈춤(마이크 분리·트랙 종료)·오류: 녹음을 버리고 상태를 정리한다. 멈춤을 누르면 stopRecording이 onstop을 바꾼다.
      const unexpected = () => {
        if (l.stopping) return;
        l.stopping = true;
        release(l);
        if (live.current !== l) return;
        live.current = null;
        post({ kind: "cancel", jobId });
        if (gen.current === mine) setState({ phase: "error", message: "녹음이 멈췄습니다. 마이크 연결을 확인하고 다시 눌러 주세요." });
      };
      rec.onstop = unexpected;
      rec.onerror = unexpected;
      rec.start(250);
      // 무음 감지(음량 수치만): 말소리가 한 번 들린 뒤 2초 조용하면 멈춘다.
      const ctx = new AudioContext();
      l.ctx = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const t0 = Date.now();
      let heard = false;
      let quietSince = 0;
      l.timer = window.setInterval(() => {
        if (gen.current !== mine || l.stopping) return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const x of buf) sum += x * x;
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();
        if (rms > SILENCE_RMS) {
          heard = true;
          quietSince = 0;
        } else if (heard && !quietSince) quietSince = now;
        const seconds = Math.floor((now - t0) / 1000);
        setState((s) => (s.phase === "recording" && s.seconds !== seconds ? { ...s, seconds } : s));
        if (now - t0 >= VOICE_MAX_SECONDS * 1000 || (quietSince && now - quietSince >= SILENCE_MS)) stopRecording(l, "send");
      }, TICK_MS);
      setState({ phase: "recording", seconds: 0, label: ready.label, model: ready.model });
    } catch (err) {
      release(l);
      live.current = null;
      post({ kind: "cancel", jobId });
      setState({ phase: "error", message: `녹음을 시작하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // 버튼: 쉬는 중이면 시작, 녹음 중이면 멈추고 보내기, 준비·변환 중이면 취소.
  const toggle = useCallback(() => {
    const l = live.current;
    if (state.phase === "recording" && l) stopRecording(l, "send");
    else if (state.phase === "starting" || state.phase === "transcribing") cancel();
    else void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, cancel]);

  // 새 대화(대화 id가 바뀜 — 새 대화 버튼·반복 작업의 이어서 진행 등 모든 경로)면 진행 중인 것을 버린다.
  const firstConv = useRef(opts.conversationId);
  useEffect(() => {
    if (firstConv.current === opts.conversationId) return;
    firstConv.current = opts.conversationId;
    cancel();
  }, [opts.conversationId, cancel]);

  // 패널이 닫히면 녹음·작업을 버린다.
  useEffect(
    () => () => {
      cancel();
      port.current?.disconnect();
      port.current = null;
    },
    [cancel],
  );

  const dismiss = useCallback(() => setState((s) => (s.phase === "error" ? { phase: "idle" } : s)), []);

  return { state, toggle, cancel, dismiss };
}

// 녹음(webm 등)을 16kHz 모노 Float32로.
async function toMono16k(data: ArrayBuffer): Promise<Float32Array> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(data);
    const frames = Math.max(1, Math.ceil(decoded.duration * VOICE_SAMPLE_RATE));
    const off = new OfflineAudioContext(1, frames, VOICE_SAMPLE_RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    return out.getChannelData(0).slice(0, Math.min(frames, VOICE_MAX_SECONDS * VOICE_SAMPLE_RATE + VOICE_SAMPLE_RATE));
  } finally {
    void ctx.close().catch(() => {});
  }
}

function isSilent(samples: Float32Array): boolean {
  let peak = 0;
  for (const x of samples) if (Math.abs(x) > peak) peak = Math.abs(x);
  return peak < SILENCE_RMS;
}

async function micErrorText(err: unknown): Promise<string> {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "마이크를 찾지 못했습니다.";
  if (name === "NotAllowedError" || name === "SecurityError") {
    let st: PermissionState | null = null;
    try {
      st = (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
    } catch {
      /* 확인 못 함 */
    }
    if (st === "denied") return "마이크가 차단되어 있습니다. 주소창에 chrome://settings/content/microphone 을 열어 이 확장을 허용한 뒤 다시 누르세요.";
    // 사이드 패널은 권한 대화상자를 띄우지 못할 수 있다: 확장 페이지(탭)에서 한 번 허용받는다.
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL("src/mic/index.html") });
      return "새 탭에서 마이크 사용을 허용한 뒤, 이 패널에서 🎤를 다시 누르세요.";
    } catch {
      return "마이크 권한이 필요합니다.";
    }
  }
  return `마이크를 쓰지 못했습니다(${name || (err instanceof Error ? err.message : String(err))}).`;
}
