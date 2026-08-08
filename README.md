# 간편 브라우저 도우미 (Simple Browser Plugin)

Chrome Side Panel에 탑재되는 OpenRouter 기반 채팅 에이전트입니다. 현재 탭의 페이지를 이해하고, 사용자의 자연어 요청을 ReAct 패턴으로 해석해 사이트 이동·번역·폼 채우기·이미지 다운로드·링크 클릭 등 실제 동작을 수행합니다.

## 주요 기능

- **채팅 기반 ReAct 에이전트** — 요청을 받으면 `describe_page`로 먼저 페이지를 관측하고, 필요한 도구를 체인 호출한 뒤 결과를 답변
- **페이지 조작 도구**
  - `describe_page` — 랜드마크(main/article/nav/aside/header/footer)별 텍스트 미리보기·대표 링크 스냅샷
  - `get_page_content` — Readability 스타일 본문 추출
  - `translate_page` — 가시 텍스트 노드 단위 번역 교체 + MutationObserver 동적 재번역
  - `find_form_fields` / `fill_form_fields` — 입력 필드 탐색·자동 입력 (승인 카드)
  - `list_page_images` / `download_images` — 이미지 URL 수집·일괄 저장 (승인 카드)
  - `find_clickables` / `click_element` — 링크·버튼 탐색·클릭 (승인 카드)
  - `navigate_to_url` — 현재 탭을 지정한 URL이나 사이트 홈으로 직접 이동 (승인 카드)
  - `query_dom` — CSS 선택자 기반 DOM 조회
- **민감 작업 승인 UI** — 사이트 이동·폼 입력·다운로드·클릭 같은 페이지 상태 변경은 실행 전 사이드 패널에 미리보기 카드를 띄워 사용자 승인을 받음
- **OpenRouter 모델 지원** — `provider/model` 형식의 모델 ID를 직접 선택하며, reasoning과 tool calling 결과를 실시간 스트리밍
- **사용자 기본 지침** — "모든 출력은 한글로" 같은 시스템 지침을 설정해 모든 대화에 적용
- **모델별 reasoning 호환성** — Gemini 3 계열의 필수 effort와 gpt-oss 출력 제한·스트림 종료 처리
- **고속 페이지 번역 경로** — 처리량 우선 provider routing, 대형 배치·중복 제거·메모리 캐시 적용
- **Shadow DOM + 동일 출처 iframe 커버리지** — 모든 툴이 shadow root와 iframe 내부까지 순회
- **PDF 이해** — 현재 탭이 PDF면 자동으로 내려받아 OpenRouter의 PDF file input으로 붙여 내용 기반 질의응답 가능 (최대 20MB)
- **디버그 타임라인** — 사이드 패널에서 🐞 버튼으로 BG·content·panel 이벤트를 실시간 추적, 복사 버튼으로 공유 가능

## 설치

1. 의존성 설치 및 빌드
   ```bash
   npm install
   npm run build
   ```
2. Chrome에서 `chrome://extensions` 열기 → 개발자 모드 활성화
3. "압축해제된 확장 프로그램 로드" 클릭 → `dist/` 폴더 선택
4. 최초 실행 시 설정(⚙)에서 [OpenRouter Keys](https://openrouter.ai/keys)에서 발급한 API 키와 사용할 모델 ID 입력 후 저장

## 사용 예시

- "이 페이지 번역해줘"
- "네이버 홈으로 이동해줘"
- "빈 입력칸 채워줘. 이름: 홍길동, 이메일: test@example.com"
- "이미지 전부 다운받아줘"
- "첫 번째 아티클로 이동해줘"
- "이 페이지 요약해줘"
- "PXG 골프공 검색해서 가장 싼 스토어로 이동해줘"
- PDF 탭에서: "이 논문 요약해줘", "결론 부분만 번역해줘", "첨부된 계약서의 핵심 조항 뽑아줘"

## 개발

```bash
npm run dev          # Vite 개발 서버 (HMR)
npm run build        # 프로덕션 빌드 → dist/
npm run typecheck    # 타입 체크만
```

### 기여 워크플로

`main` 브랜치는 보호되어 있으며 직접 push가 불가능합니다. 모든 변경은 feature branch + Pull Request로 반영합니다.

```bash
git checkout -b feat/your-change
# ... 작업 ...
git commit -m "feat: ..."
git push -u origin feat/your-change
gh pr create --base main --title "..." --body "..."
```

## 아키텍처

```
[Side Panel React UI] ⇄ long-lived port ⇄ [Background Service Worker] ⇄ tabs.sendMessage ⇄ [Content Script]
                                                    │
                                                    ├── OpenRouter Chat Completions API
                                                    ├── ReAct stream loop (reasoning_details 보존)
                                                    ├── Tool dispatcher (zod 인자 검증)
                                                    └── webNavigation 통합 (settle 대기)
```

### 주요 구성

- **Manifest V3** — `sidePanel`, `storage`, `scripting`, `activeTab`, `downloads`, `tabs`, `alarms`, `webNavigation` 권한 + `host_permissions: ["<all_urls>"]`
- **Port 하트비트 + 자동 재연결** — MV3 서비스 워커 유휴 종료 대응
- **스트림 청크 무활동 워치독** (60초) + **초기 연결 타임아웃** (20초) + **툴별 타임아웃** (기본 30초, translate 180초)
- **webNavigation 기반 settle 대기** — URL 이동·클릭 직후 페이지 전환 중에 후속 툴이 경쟁 조건 만나지 않도록

## 보안 / 프라이버시

- OpenRouter API 키는 `chrome.storage.local`에 평문 저장 (OpenRouter API 호출에만 사용; v1 트레이드오프)
- 키는 BG 서비스 워커에서만 읽히며 content script나 페이지 DOM에 전달되지 않음
- 민감 툴 실행 전 사용자 승인 필수
- 다운로드·탐색 URL은 `http(s):`만 허용, `javascript:` / 제어문자 차단

## 스택

Vite · TypeScript · React 18 · zustand · zod · OpenRouter API · `@crxjs/vite-plugin`

## 라이선스

MIT
