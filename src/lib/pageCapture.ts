// 보고 있는 페이지 캡처(capture_page, #49)의 순수 계산. chrome API·DOM 없이 계산해 단위 테스트한다.
// - 캡처할 수 없는 탭: 주소의 형태(scheme·웹 스토어 호스트)로만 판정한다.
// - 전체 캡처: 맨 위부터 화면 높이씩 스크롤할 다음 위치, 높이 상한, 이어 붙일 띠(타일 → 결과 이미지 조각) 배치.
// - 저장 이름: 사이트(호스트)와 시각으로 확장이 정한다(페이지 제목·경로·쿼리는 넣지 않는다).

export const CAPTURE_LIMITS = {
  // 전체 캡처의 높이 상한(CSS px). 무한 스크롤 페이지는 여기서 멈추고 잘렸다고 알린다.
  maxPageHeight: 20_000,
  // 한 번에 찍는 화면 수 상한(낮은 창에서 상한 높이까지 가도 넘지 않게 넉넉히).
  maxTiles: 80,
  // 결과 이미지 한 장의 한 변(장치 px)과 넓이 상한. 넘으면 여러 장으로 나눈다(캔버스 한도·메모리).
  maxPartSide: 16_384,
  maxPartArea: 16_384 * 4_096,
  // captureVisibleTab은 초당 2회까지라 호출 사이를 이만큼 띄운다.
  captureGapMs: 600,
} as const;

// ── 캡처할 수 없는 탭 ──

const INTERNAL_SCHEMES = new Set(["chrome:", "edge:", "about:", "chrome-search:", "chrome-untrusted:", "devtools:", "view-source:"]);

// 이 주소의 탭을 캡처할 수 없는 이유. 없으면 null(시도해 본다 — 그래도 브라우저가 막으면 실행 때 알린다).
export function captureBlockReason(url: string | undefined): string | null {
  if (!url) return "탭 주소를 알 수 없어 캡처할 수 없음";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "탭 주소를 알 수 없어 캡처할 수 없음";
  }
  if (INTERNAL_SCHEMES.has(u.protocol)) return "브라우저 내부 페이지(새 탭·설정 등)는 확장이 캡처할 수 없음";
  if (u.protocol === "chrome-extension:") return "확장 프로그램의 페이지는 캡처할 수 없음";
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "file:") {
    return "웹 페이지가 아닌 탭(data:·blob: 등)은 캡처할 수 없음";
  }
  const host = u.hostname.toLowerCase();
  if (host === "chromewebstore.google.com" || (host === "chrome.google.com" && /^\/webstore(\/|$)/.test(u.pathname))) {
    return "Chrome 웹 스토어 페이지는 브라우저 정책상 확장이 캡처할 수 없음";
  }
  return null;
}

// ── 전체 캡처: 다음 스크롤 위치 ──

// 지금까지 담은 아래 끝(coveredBottom, CSS px)에서 다음에 스크롤할 위치. 다 담았으면 null.
// 마지막 화면은 페이지(또는 상한) 끝에 맞춰 앞 화면과 겹치게 찍고, 겹친 부분은 이어 붙일 때 버린다.
export function nextTileY(o: {
  coveredBottom: number;
  pageHeight: number;
  viewportHeight: number;
  maxHeight?: number;
}): number | null {
  const limit = Math.min(o.pageHeight, o.maxHeight ?? CAPTURE_LIMITS.maxPageHeight);
  if (o.viewportHeight <= 0 || o.coveredBottom >= limit) return null;
  return Math.max(0, Math.min(o.coveredBottom, limit - o.viewportHeight));
}

// ── 이어 붙이기 배치 ──

export interface StitchDraw {
  // 몇 번째 화면(타일)에서
  tile: number;
  // 그 화면 안의 위치와 높이(CSS px). 화면 이미지의 실제 배율은 이어 붙일 때 이미지 크기로 구한다.
  srcY: number;
  srcHeight: number;
  // 결과 조각 안의 위치와 높이(장치 px).
  destY: number;
  destHeight: number;
}

export interface StitchPart {
  // 결과 전체에서 이 조각이 시작하는 위치와 높이(장치 px).
  top: number;
  height: number;
  draws: StitchDraw[];
}

export interface StitchPlan {
  // 결과 이미지 폭(장치 px, 세로 스크롤 막대 제외)과 전체 높이(장치 px).
  width: number;
  height: number;
  parts: StitchPart[];
}

// 찍은 화면들(실제 스크롤 위치 tiles, CSS px)을 높이 totalHeight(CSS px)의 한 장으로 이어 붙이는 배치.
// 각 화면은 앞 화면이 담지 못한 부분만 쓴다(겹친 부분 버림). 장치 px(scale = devicePixelRatio)로 바꾼 결과가
// 한 변·넓이 상한을 넘으면 여러 조각으로 나눈다. 폭이 상한을 넘으면 null(캡처할 수 없음).
export function planStitch(o: {
  tiles: readonly number[];
  viewportWidth: number;
  viewportHeight: number;
  totalHeight: number;
  scale: number;
  maxPartSide?: number;
  maxPartArea?: number;
}): StitchPlan | null {
  const maxSide = o.maxPartSide ?? CAPTURE_LIMITS.maxPartSide;
  const maxArea = o.maxPartArea ?? CAPTURE_LIMITS.maxPartArea;
  const scale = o.scale > 0 ? o.scale : 1;
  const width = Math.round(o.viewportWidth * scale);
  const height = Math.round(o.totalHeight * scale);
  if (width <= 0 || height <= 0 || width > maxSide) return null;
  // 화면마다 새로 담는 구간(CSS px).
  const segs: Array<{ tile: number; y: number; start: number; end: number }> = [];
  let covered = 0;
  o.tiles.forEach((y, tile) => {
    const start = Math.max(y, covered);
    const end = Math.min(y + o.viewportHeight, o.totalHeight);
    if (end > start) segs.push({ tile, y, start, end });
    covered = Math.max(covered, end);
  });
  const partHeight = Math.max(1, Math.min(maxSide, Math.floor(maxArea / width)));
  const parts: StitchPart[] = [];
  for (let top = 0; top < height; top += partHeight) {
    const bottom = Math.min(height, top + partHeight);
    const draws: StitchDraw[] = [];
    for (const s of segs) {
      const a = Math.max(Math.round(s.start * scale), top);
      const b = Math.min(Math.round(s.end * scale), bottom);
      if (b <= a) continue;
      draws.push({ tile: s.tile, srcY: a / scale - s.y, srcHeight: (b - a) / scale, destY: a - top, destHeight: b - a });
    }
    parts.push({ top, height: bottom - top, draws });
  }
  return { width, height, parts };
}

// ── 저장 이름 ──

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

// 사이트(호스트)와 시각(로컬)으로 정한 PNG 이름. 전체 캡처는 _full, 여러 장이면 -1, -2 …
export function captureFileName(
  pageUrl: string,
  at: Date,
  o: { fullPage: boolean; part?: number; parts?: number },
): string {
  let site = "page";
  try {
    const u = new URL(pageUrl);
    if (u.protocol === "file:") site = "local-file";
    else if (u.hostname) site = u.hostname;
  } catch {
    /* 기본 이름 */
  }
  site = site.replace(/[^A-Za-z0-9.-]/g, "_").replace(/^\.+|\.+$/g, "").slice(0, 60) || "page";
  const ts = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const multi = (o.parts ?? 1) > 1 ? `-${o.part ?? 1}` : "";
  return `${site}_${ts}${o.fullPage ? "_full" : ""}${multi}.png`;
}

// PNG 바이트의 크기(IHDR). PNG가 아니면 null.
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// ── content script와 주고받는 값 ──

// 전체 캡처를 시작할 때 문서에서 잰 값(CSS px). viewport*는 스크롤 막대를 뺀 보이는 영역, window*는 막대를 포함한
// 창 안쪽 크기(innerWidth·innerHeight — 캡처 이미지의 크기에 해당, 화면 이미지의 배율을 구할 때도 쓴다).
export interface CaptureMetrics {
  token: string;
  // PDF 뷰어처럼 문서를 스크롤해 찍을 수 없는 페이지.
  pdf: boolean;
  pageHeight: number;
  pageWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  windowWidth: number;
  windowHeight: number;
  scale: number;
  // 문서는 스크롤되지 않고 안쪽 영역(div)이 스크롤되는 앱형 페이지로 보이는지(구조: overflow·크기).
  innerScroll: boolean;
}

// 그때의 보이는 영역·창 안쪽 크기·배율(시작 때와 다르면 캡처를 멈춘다).
export interface CaptureViewport {
  viewportWidth: number;
  viewportHeight: number;
  windowWidth: number;
  windowHeight: number;
  scale: number;
}

export interface CaptureScrolled extends CaptureViewport {
  // 실제로 간 스크롤 위치(페이지가 덜 갈 수 있다)와 그때의 문서 높이.
  y: number;
  pageHeight: number;
}

// 캡처하는 동안 창 크기·배율이 바뀌었는지. 바뀌면 화면마다 크기가 달라 이어 붙인 이미지에 빈 곳·어긋남이 생긴다.
export function viewportChanged(start: CaptureViewport, now: CaptureViewport): boolean {
  return (
    Math.abs(start.viewportWidth - now.viewportWidth) > 0.5 ||
    Math.abs(start.viewportHeight - now.viewportHeight) > 0.5 ||
    Math.abs(start.windowWidth - now.windowWidth) > 0.5 ||
    Math.abs(start.windowHeight - now.windowHeight) > 0.5 ||
    Math.abs(start.scale - now.scale) > 0.001
  );
}

// 찍은 화면 이미지(첫 장 포함 모든 장)의 폭·높이가 시작 때 잰 창 안쪽 크기 × 배율과 맞는지(±2px — 배율이 소수면
// 반올림 차이). 재고 나서 찍기 전에 창 크기가 바뀌었으면 여기서 걸린다.
export function tileSizeMatches(tile: { width: number; height: number }, start: CaptureViewport): boolean {
  return Math.abs(tile.width - start.windowWidth * start.scale) <= 2 && Math.abs(tile.height - start.windowHeight * start.scale) <= 2;
}

// ── offscreen 문서의 이어 붙이기 작업 ──

// 찍은 화면(PNG Blob)들을 배치대로 이어 붙여 PNG 조각들로 만든다. 조각은 offscreen 문서의 blob: 주소로 돌려주고,
// 저장이 끝나면 capture_release로 놓는다.
export interface StitchJob {
  kind: "capture_stitch";
  tiles: Blob[];
  plan: StitchPlan;
  viewportWidth: number;
  windowWidth: number;
}

export type StitchResult =
  | { ok: true; parts: Array<{ url: string; bytes: number; width: number; height: number }> }
  | { ok: false; kind: "failed" | "cancelled" | "timeout" | "closed" };

export interface StitchReleaseJob {
  kind: "capture_release";
  urls: string[];
}
