# 간편 브라우저 도우미 (Simple Browser Plugin)

Chrome Side Panel에 탑재되는 OpenRouter 기반 채팅 에이전트입니다. 현재 탭의 페이지를 이해하고, 사용자의 자연어 요청을 ReAct 패턴으로 해석해 사이트 이동·번역·폼 채우기·이미지 다운로드·링크 클릭 등 실제 동작을 수행합니다.

## 주요 기능

- **채팅 기반 ReAct 에이전트** — 요청을 받으면 `describe_page`로 먼저 페이지를 관측하고, 필요한 도구를 체인 호출한 뒤 결과를 답변
- **페이지 조작 도구**
  - `describe_page` — 랜드마크(main/article/nav/aside/header/footer)별 텍스트 미리보기·대표 링크 스냅샷
  - `get_page_content` — Readability 스타일 본문 추출
  - `translate_page` — 가시 텍스트 노드 단위 번역 교체 + MutationObserver 동적 재번역
  - `find_form_fields` / `fill_form_fields` — 입력 필드 탐색·자동 입력, 칸마다 반영 여부 확인 (승인 카드)
  - `list_page_images` / `download_images` — 이미지 URL 수집·일괄 저장 (승인 카드)
  - `find_clickables` / `click_element` — 링크·버튼 탐색·클릭, 클릭 뒤 이동·화면 변화 보고 (승인 카드)
  - `navigate_to_url` — 현재 탭을 지정한 URL이나 사이트 홈으로 직접 이동 (승인 카드)
  - `query_dom` — CSS 선택자 기반 DOM 조회
  - `get_youtube_transcript` — YouTube 영상의 "스크립트 표시" 패널을 열어 타임스탬프 포함 자막 추출
  - `list_file_links` — 페이지의 첨부·다운로드 파일 링크와 짐작한 형식 목록
  - `read_document` — 링크된 파일을 화면 이동 없이 내려받아 텍스트로 읽기 (브라우저 안에서 처리, 최대 20MB, 한 요청에 5개까지) (승인 카드)
    - Word·Excel·PowerPoint(.docx/.xlsx/.pptx), OpenDocument(.odt/.ods/.odp) → Markdown ([docling.rs-wasm](https://github.com/docling-project/docling.rs))
    - PDF → 쪽별 글자 ([pdf.js](https://github.com/mozilla/pdf.js)), 한글(.hwp/.hwpx) → Markdown ([kordoc](https://github.com/chrisryugj/kordoc)), CSV/TSV → Markdown 표(구분자 자동 판별, 설정한 글자 수 한도에서 멈춤 — 기본 40,000자, 1,000~100,000), TXT/MD → 원문
    - 확장자 없는 다운로드 링크(`download.do?fileId=…`)는 응답 헤더와 파일 서명으로 형식 판별. CSV·TXT의 EUC-KR(CP949) 자동 인식
- **민감 작업 승인 UI** — 사이트 이동·폼 입력·다운로드·클릭 같은 페이지 상태 변경과 문서 URL 요청(쿠키 포함)은 실행 전 사이드 패널에 미리보기 카드를 띄워 사용자 승인을 받음
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
- YouTube 영상에서: "이 영상 요약해줘", "가격 얘기는 몇 분쯤 나와?"
- 첨부 파일이 있는 페이지에서: "이 공고의 첨부 한글 파일 요약해줘", "이 페이지의 엑셀 파일 내용 정리해줘", "https://…/report.pdf 요약해줘"

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

- **Manifest V3** — `sidePanel`, `storage`, `scripting`, `activeTab`, `downloads`, `tabs`, `alarms`, `webNavigation`, `identity`, `offscreen`, `webRequest` 권한 + `host_permissions: ["<all_urls>"]`
- **Port 하트비트 + 자동 재연결** — MV3 서비스 워커 유휴 종료 대응
- **스트림 청크 무활동 워치독** (60초) + **초기 연결 타임아웃** (20초) + **툴별 타임아웃** (기본 30초, translate 180초)
- **webNavigation 기반 settle 대기** — URL 이동·클릭 직후 페이지 전환 중에 후속 툴이 경쟁 조건 만나지 않도록
- **문서 변환 격리** — `read_document`는 offscreen 문서 안의 Worker에서 변환하고(형식에 맞는 변환기만 불러옴), 10초가 지나거나 사용자가 중단하면 Worker를 강제 종료. zip 기반 문서(Office·OpenDocument·HWPX)는 직접 풀어 크기를 센 뒤(본문 6MB·전체 40MB) 다시 만들어 넘기며, 이미지 등 바이너리는 비워서 넘김. PDF(pdf.js 워커에 빌드 때 패치)와 HWP(zlib 셰임)도 압축 해제량에 한도를 둠(문서당 128MB·256MB). 1분 동안 쓰지 않으면 offscreen 문서를 닫음
- **클릭·입력 확인 경로** — `find_clickables`·`find_form_fields`가 준 id마다 그때의 대상 기술(역할·글자·주소·영역·목록 순번·대상이 든 행의 글자)을 content script 메모리에 둠. 승인 카드를 띄울 때 지금 요소가 그때와 같은지 확인해 사람이 알아볼 수 있게 보여 주고(비밀번호 칸은 값을 가림), 실행 직전과, 클릭은 스크롤·포커스 뒤 누르기 바로 앞에서 다시 승인한 기술과 같을 때만 실행. 요소가 다시 그려져 사라졌으면 비슷한 요소로 대신하지 않고 멈춤(다시 찾아 새로 승인). 승인은 그 호출에 한 번만 쓰임. id에는 페이지마다 바뀌는 꼬리표가 붙어 이전 페이지의 id는 거부
- **실행 결과 확인** — 클릭 뒤 이동 종류(없음·페이지 안 위치(#)·같은 사이트·다른 사이트·오류), 페이지 안 주소 변경, 새 탭, 화면 변화(DOM 변경 수·대화상자)를 결과로 돌려줌. 입력은 페이지 처리가 끝날 틈(150ms)을 둔 뒤 칸마다 값을 다시 읽어 실제로 반영됐는지 알려 줌
- **동작 기록** — 승인한 클릭·입력마다 페이지 구분 키(주소 틀 + 페이지 뼈대 해시), 대상 요약, 결과(완료·일부 반영·직전 중단·실패·취소)를 `chrome.storage.local`에만 남김. 주소 틀은 사람이 붙인 이름처럼 보이는 경로 낱말만 남기고 숫자·토큰·이메일·한글 이름 같은 칸은 자리표시로 바꾸며, 쿼리는 이름만 남김(`/board/{n}/view?id`). 대상 이름에 섞인 주소·이메일·key=value·긴 숫자·비밀 값처럼 보이는 낱말도 가리고, 비밀번호·결제 칸은 이름을 남기지 않음. 뼈대 해시는 랜드마크·목록·표·폼의 중첩만 보고 같은 틀의 목록 항목은 하나로 접어, 내용과 항목 수가 달라도 같은 값. 입력 값, 대상이 든 행의 글자, 링크 주소의 값은 남기지 않고, 실패 이유도 문구 대신 분류만 남김. 시크릿 창은 기록하지 않고, 30일·500건·약 1MB를 넘으면 오래된 것부터 지움(한 항목의 대상은 20개까지). 설정에서 끄거나 지울 수 있음. 나중에 같은 구조의 페이지에서 동작을 다시 쓰는 레시피의 재료
- **문서 요청 안전장치** — 리다이렉트는 따라가지 않고 목적지 주소만 알려 줌(`webRequest`로 관찰). 그 주소로 다시 읽으면 새 승인 카드가 뜸. 웹 페이지·이미지·압축 파일 등 문서가 아닌 확장자는 요청하지 않음. 확장자 없는 링크는 승인 카드에 따로 경고
- **kordoc 브라우저 번들** — kordoc는 Node용이라 `vendor/kordoc/`에서 따로 설치해 브라우저용으로 묶은 결과물을 커밋해 씀(`npm run vendor:kordoc`로 다시 만듦, [vendor/kordoc/README.md](vendor/kordoc/README.md))

## 보안 / 프라이버시

- OpenRouter API 키는 `chrome.storage.local`에 평문 저장 (OpenRouter API 호출에만 사용; v1 트레이드오프)
- 키는 BG 서비스 워커에서만 읽히며 content script나 페이지 DOM에 전달되지 않음
- 민감 툴 실행 전 사용자 승인 필수
- 다운로드·탐색 URL은 `http(s):`만 허용, `javascript:` / 제어문자 차단

## 스택

Vite · TypeScript · React 18 · zustand · zod · OpenRouter API · `@crxjs/vite-plugin` · docling.rs-wasm · pdf.js · kordoc

## 라이선스

MIT
