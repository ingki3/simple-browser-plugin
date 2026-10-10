import type { YoutubeTranscript } from "@/lib/messages";

// 자막 트랙 URL(timedtext)을 직접 받아오는 방식은 2025년부터 플레이어가 만드는
// PO 토큰 없이는 빈 응답이 온다. 대신 YouTube 화면의 "스크립트 표시" 패널을 열어
// 플레이어가 받아 그린 결과를 읽는다.
const PANEL_SELECTOR =
  'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]';
// 구형(ytd-transcript-segment-renderer)과 신형(transcript-segment-view-model) UI 모두 대응.
const SEGMENT_SELECTOR = "ytd-transcript-segment-renderer, transcript-segment-view-model";
const OPEN_BUTTON_SELECTOR = "ytd-video-description-transcript-section-renderer button";
const DESCRIPTION_EXPAND_SELECTOR = "ytd-watch-metadata #description-inner #expand, tp-yt-paper-button#expand";
// 설명란 버튼을 못 찾았을 때 접근성 라벨·텍스트로 찾는다. UI 언어마다 문구가 다르다.
const TRANSCRIPT_LABEL = /transcript|스크립트|대본|文字起こし|文字记录|字幕|transcripción|transcription|transkript/i;
const TIMESTAMP = /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}/;
const WAIT_MS = 10_000;
const POLL_MS = 200;
const DEFAULT_MAX_CHARS = 40_000;

interface Segment {
  time: string;
  text: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clean(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

function currentVideoId(): string | null {
  if (!/(^|\.)youtube\.com$/i.test(location.hostname)) return null;
  const url = new URL(location.href);
  if (url.pathname === "/watch") return url.searchParams.get("v");
  return url.pathname.match(/^\/(?:shorts|live)\/([\w-]{6,})/)?.[1] ?? null;
}

function readSegments(): Segment[] {
  const scope = document.querySelector(PANEL_SELECTOR) ?? document;
  return Array.from(scope.querySelectorAll(SEGMENT_SELECTOR)).flatMap((el) => {
    const whole = clean(el.textContent);
    const time =
      clean(el.querySelector(".segment-timestamp, [class*='timestamp']")?.textContent) ||
      whole.match(TIMESTAMP)?.[0].trim() ||
      "";
    const textEl = el.querySelector(".segment-text, [class*='segment-text']");
    const text = textEl ? clean(textEl.textContent) : clean(whole.replace(TIMESTAMP, ""));
    return text ? [{ time, text }] : [];
  });
}

function findOpenButton(): HTMLElement | null {
  const direct = document.querySelector<HTMLElement>(OPEN_BUTTON_SELECTOR);
  if (direct) return direct;
  const candidates = document.querySelectorAll<HTMLElement>(
    "ytd-watch-metadata button, #description button, ytd-menu-popup-renderer tp-yt-paper-item",
  );
  for (const el of candidates) {
    const label = el.getAttribute("aria-label") ?? "";
    const text = clean(el.textContent);
    if (TRANSCRIPT_LABEL.test(label) || (text.length < 40 && TRANSCRIPT_LABEL.test(text))) {
      return el;
    }
  }
  return null;
}

async function waitForSegments(): Promise<Segment[]> {
  const deadline = Date.now() + WAIT_MS;
  let last: Segment[] = [];
  while (Date.now() < deadline) {
    const segments = readSegments();
    // 패널이 줄을 나눠 그리는 중일 수 있으니 개수가 한 번 더 같을 때까지 기다린다.
    if (segments.length && segments.length === last.length) return segments;
    last = segments;
    await sleep(POLL_MS);
  }
  return last;
}

function closePanel(): void {
  const close = document.querySelector<HTMLElement>(
    `${PANEL_SELECTOR} #visibility-button button, ${PANEL_SELECTOR} button[aria-label*="Close" i], ${PANEL_SELECTOR} button[aria-label*="닫기"]`,
  );
  close?.click();
}

function readMetadata(): { title: string; channel: string } {
  const title =
    clean(document.querySelector("ytd-watch-metadata h1")?.textContent) ||
    document.title.replace(/\s*-\s*YouTube\s*$/, "");
  const channel = clean(
    document.querySelector("ytd-watch-metadata ytd-channel-name a, #owner #channel-name a")
      ?.textContent,
  );
  return { title, channel };
}

export async function getYoutubeTranscript(args: {
  includeTimestamps?: boolean;
  maxChars?: number;
}): Promise<YoutubeTranscript> {
  const videoId = currentVideoId();
  if (!videoId) {
    throw new Error("현재 탭이 YouTube 영상 페이지(youtube.com/watch, /shorts/, /live/)가 아닙니다.");
  }

  let segments = readSegments();
  let openedByUs = false;
  if (!segments.length) {
    let button = findOpenButton();
    if (!button) {
      // 설명란이 접혀 있으면 스크립트 버튼이 아직 렌더링되지 않았을 수 있다.
      document.querySelector<HTMLElement>(DESCRIPTION_EXPAND_SELECTOR)?.click();
      await sleep(500);
      button = findOpenButton();
    }
    if (!button) {
      throw new Error(
        "이 영상에서 '스크립트 표시' 버튼을 찾지 못했습니다. 자막이 없는 영상이거나(Shorts는 대부분 미지원) YouTube 화면 구조가 바뀌었을 수 있습니다.",
      );
    }
    button.click();
    openedByUs = true;
    segments = await waitForSegments();
  }

  if (openedByUs) closePanel();
  if (!segments.length) {
    throw new Error(
      `스크립트 패널을 열었지만 ${WAIT_MS / 1000}초 안에 내용이 표시되지 않았습니다. 자막이 없는 영상일 수 있습니다.`,
    );
  }

  const includeTimestamps = args.includeTimestamps !== false;
  const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;
  const full = segments
    .map((s) => (includeTimestamps && s.time ? `[${s.time}] ${s.text}` : s.text))
    .join("\n");
  const truncated = full.length > maxChars;

  return {
    videoId,
    url: location.href,
    ...readMetadata(),
    segmentCount: segments.length,
    transcript: truncated ? full.slice(0, maxChars) : full,
    truncated,
  };
}
