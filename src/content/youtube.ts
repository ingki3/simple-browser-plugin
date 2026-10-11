import type { YoutubeTranscript } from "@/lib/messages";

// 자막 트랙 URL(timedtext)을 직접 받아오는 방식은 2025년부터 플레이어가 만드는
// PO 토큰 없이는 빈 응답이 온다. 대신 YouTube 화면의 "스크립트 표시" 패널을 열어
// 플레이어가 받아 그린 결과를 읽는다.
// 스크립트 패널의 target-id는 영상마다 다르고(PAmodern_transcript_view, 없음 등) 이전 영상의
// 숨은 패널도 남아 있다. 그래서 "펼쳐져 있고 세그먼트가 든 패널"을 스크립트 패널로 본다.
const PANEL_SELECTOR = "ytd-engagement-panel-section-list-renderer";
const PANEL_EXPANDED = "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
// 구형(ytd-transcript-segment-renderer)과 신형(transcript-segment-view-model) UI 모두 대응.
const SEGMENT_SELECTOR = "ytd-transcript-segment-renderer, transcript-segment-view-model";
const SEGMENT_TIME_SELECTOR = ".segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp";
const SEGMENT_TEXT_SELECTOR = ".segment-text, span[role='text']";
// 신형 UI는 "1초", "3분 23초" 같은 스크린리더용 시간 라벨을 본문 옆에 둔다.
const A11Y_LABEL_SELECTOR = "[class*='A11yLabel']";
// 승인 없이 실행되는 도구라 클릭 대상은 스크립트 전용 컨테이너 안의 버튼으로만 한정한다.
// 라벨 문구로 아무 버튼이나 찾으면 구독·좋아요 같은 계정 동작을 누를 수 있다.
const OPEN_BUTTON_SELECTOR = "ytd-video-description-transcript-section-renderer button";
const DESCRIPTION_EXPAND_SELECTOR = "ytd-watch-metadata #description-inner #expand";
// 로딩 중 표시. 이게 패널에 남아 있으면 아직 줄을 더 그리는 중이다.
const LOADING_SELECTOR = "ytd-continuation-item-renderer, tp-yt-paper-spinner[active]";
const TIMESTAMP = /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}/;
const WAIT_MS = 10_000;
const POLL_MS = 200;
// 줄 수가 이 시간 동안 변하지 않고 로딩 표시가 없으면 다 그려진 것으로 본다.
const STABLE_MS = 1_000;
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

function findPanel(): Element | null {
  return (
    Array.from(document.querySelectorAll(PANEL_SELECTOR)).find(
      (p) => p.getAttribute("visibility") === PANEL_EXPANDED && p.querySelector(SEGMENT_SELECTOR),
    ) ?? null
  );
}

function readSegments(): Segment[] {
  const panel = findPanel();
  if (!panel) return [];
  return Array.from(panel.querySelectorAll(SEGMENT_SELECTOR)).flatMap((el) => {
    const bare = el.cloneNode(true) as Element;
    bare.querySelectorAll(A11Y_LABEL_SELECTOR).forEach((n) => n.remove());
    const whole = clean(bare.textContent);
    const time =
      clean(bare.querySelector(SEGMENT_TIME_SELECTOR)?.textContent) ||
      whole.match(TIMESTAMP)?.[0].trim() ||
      "";
    const textEl = bare.querySelector(SEGMENT_TEXT_SELECTOR);
    const text = textEl ? clean(textEl.textContent) : clean(whole.replace(TIMESTAMP, ""));
    return text ? [{ time, text }] : [];
  });
}

function findOpenButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>(OPEN_BUTTON_SELECTOR);
}

function isLoading(): boolean {
  return !!findPanel()?.querySelector(LOADING_SELECTOR);
}

// 대기 중 SPA 이동으로 다른 영상이 열리면 그 영상의 자막을 섞어 돌려주게 된다.
function assertSameVideo(videoId: string): void {
  if (currentVideoId() !== videoId) {
    throw new Error("스크립트를 읽는 중에 다른 영상으로 이동했습니다. 다시 요청해 주세요.");
  }
}

async function waitForSegments(
  videoId: string,
): Promise<{ segments: Segment[]; complete: boolean }> {
  const deadline = Date.now() + WAIT_MS;
  let segments: Segment[] = [];
  let lastCount = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    assertSameVideo(videoId);
    segments = readSegments();
    if (segments.length !== lastCount) {
      lastCount = segments.length;
      stableSince = Date.now();
      continue;
    }
    if (segments.length && !isLoading() && Date.now() - stableSince >= STABLE_MS) {
      return { segments, complete: true };
    }
  }
  return { segments, complete: false };
}

function expandedPanels(): Element[] {
  return Array.from(document.querySelectorAll(PANEL_SELECTOR)).filter(
    (p) => p.getAttribute("visibility") === PANEL_EXPANDED,
  );
}

function closePanel(panel: Element): void {
  panel
    .querySelector<HTMLElement>(
      '#visibility-button button, button[aria-label*="Close" i], button[aria-label*="닫기"]',
    )
    ?.click();
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

  let segments: Segment[];
  let complete: boolean;
  let stalled = false;
  if (readSegments().length) {
    // 이미 열린 패널이라도 일부만 그려진 상태일 수 있으니 안정될 때까지 기다린다.
    ({ segments, complete } = await waitForSegments(videoId));
  } else {
    let button = findOpenButton();
    if (!button) {
      // 설명란이 접혀 있으면 스크립트 버튼이 아직 렌더링되지 않았을 수 있다.
      document.querySelector<HTMLElement>(DESCRIPTION_EXPAND_SELECTOR)?.click();
      await sleep(500);
      assertSameVideo(videoId);
      button = findOpenButton();
    }
    if (!button) {
      throw new Error(
        "이 영상에서 '스크립트 표시' 버튼을 찾지 못했습니다. 자막이 없는 영상이거나(Shorts는 대부분 미지원) YouTube 화면 구조가 바뀌었을 수 있습니다.",
      );
    }
    // 클릭으로 새로 펼쳐진 패널만 도구가 연 것으로 보고 닫는다. 내용이 안 뜬 패널도 닫아야 한다.
    const before = new Set(expandedPanels());
    // 대기 중 사용자가 연 댓글 등 다른 패널은 제외한다. 스크립트 패널의 target-id는 없거나 transcript를 포함한다.
    const opened = () =>
      expandedPanels().filter((p) => {
        const target = p.getAttribute("target-id");
        return !before.has(p) && (!target || target === "null" || /transcript/i.test(target));
      });
    button.click();
    try {
      ({ segments, complete } = await waitForSegments(videoId));
    } finally {
      // 다른 영상으로 이동했다면 지금 패널은 사용자가 연 것일 수 있으니 건드리지 않는다.
      if (currentVideoId() === videoId) {
        const mine = opened();
        stalled = mine.some((p) => p.querySelector(LOADING_SELECTOR));
        mine.forEach(closePanel);
      }
    }
  }

  assertSameVideo(videoId);
  if (!segments.length) {
    throw new Error(
      stalled
        ? `YouTube가 ${WAIT_MS / 1000}초 안에 스크립트를 불러오지 못했습니다(로딩이 끝나지 않음). 페이지를 새로고침한 뒤 다시 시도해 주세요.`
        : `스크립트 패널을 열었지만 ${WAIT_MS / 1000}초 안에 내용이 표시되지 않았습니다. 자막이 없는 영상일 수 있습니다.`,
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
    complete,
  };
}
