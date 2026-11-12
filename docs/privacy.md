# 개인정보처리방침 (Privacy Policy)

간편 브라우저 도우미(Simple Browser Plugin, 이하 "확장") · 시행일 2026-11-05

[English below](#english)

이 확장은 오픈소스 Chrome 확장입니다. 이 프로젝트는 사용자 데이터를 받는 서버를 운영하지 않습니다. 확장은 사용자가 요청한 일을 하려고
사용자가 설정에서 고른 서비스로만 데이터를 보내고, 나머지는 이 브라우저 안에만 둡니다.

## 1. AI 서비스로 보내는 것

사용자는 설정에서 AI 서비스 하나(OpenRouter, OpenAI, Google Gemini, Anthropic Claude, 또는 사용자가 주소를 직접 적은 로컬·호환 서버)를 고르고 자기 API 키를 넣습니다(로컬 서버는 키가 선택).
로컬·호환 서버를 고르면 아래 내용은 그 주소의 서버로만 갑니다. 다른 컴퓨터의 서버(https)를 적었다면 그 서버를 운영하는 쪽이 내용을 받습니다.
요청을 보내면 그 요청을 처리하려고 다음을 그 서비스로 보냅니다.

- 대화: 사용자가 쓴 요청, 모델의 답, 도구를 실행한 결과
- 지금 탭의 **전체 주소(쿼리·해시 포함)와 제목**: 요청마다 함께 보냅니다
- 페이지 내용: 요약·번역·읽기를 할 때 페이지의 글자를 읽어 보냅니다. **화면에 보이지 않는 요소의 글자, 편집 영역의 글자, 입력칸의 초기 글자가 들어갈 수 있습니다.**
  찾기·클릭·입력 도구의 결과에는 입력칸에 사용자가 쓴 값을 넣지 않습니다.
- 요청에 필요한 파일: PDF 탭의 PDF, 읽으라고 한 첨부 파일·링크 문서, 읽기를 고른 다른 탭의 내용
- 링크한 글: 고른 링크의 본문. 보통은 로그인 정보 없이 받아 읽고, 그걸로 읽지 못해 카드에서 "로그인된 상태로 새 탭으로 열어 읽기"를 승인하면 그 링크를 사용자의 로그인 상태로 뒤에서 열어 읽은 본문을 보냅니다(탭은 읽은 뒤 닫음)
- 현재 날짜·시각·시간대(예: Asia/Seoul)
- 저장한 링크의 이름·용도·사이트·자리 이름(다시 쓸 후보로)
- 음성 입력을 켠 경우: 녹음한 음성을 설정에서 고른 음성 제공자로 보냅니다(대화 제공자와 다를 수 있음). 녹음은 저장하지 않습니다.

OpenRouter를 고르면 OpenRouter가 고른 모델의 회사로 다시 전달합니다. 보낸 데이터의 처리는 각 서비스의 방침을 따릅니다:
[OpenRouter](https://openrouter.ai/privacy), [OpenAI](https://openai.com/policies/privacy-policy/),
[Google](https://policies.google.com/privacy), [Anthropic](https://www.anthropic.com/legal/privacy).

### 사용자가 패널에 없을 때 보내는 경우

- **반복 작업**: 사용자가 승인해 등록한 반복 작업은 정한 간격마다, 새 요청 없이 패널이 닫혀 있어도, 백그라운드의 탭에서 대상 페이지를 열어
  조건과 그 페이지의 주소·제목·글자·버튼 정보를 AI 서비스로 보냅니다. 멈추거나 지우려면 설정 → 동작 → 반복 작업에서 멈추기·지우기를 누릅니다.
- **텔레그램·MCP 요청**: 아래 선택 기능을 켜면, 그쪽에서 온 요청도 위와 같은 범위를 AI 서비스로 보냅니다.

## 2. 선택 기능이 보내는 것 (켤 때만)

- **텔레그램 연동**: 요청·최종 답·승인 질문(요청 글, 할 일, 이동할 주소, 누를 대상의 이름, 입력할 칸과 값(비밀번호는 글자 수만), 읽거나 저장할 파일·링크의 주소, 캡처할 화면)과 반복 작업 알림(작업 이름)이 텔레그램 서버를 거쳐
  사용자가 연결한 텔레그램 채팅 하나로 갑니다. "알림에 확인 결과 요약도 보내기"(기본 끔)를 켜면 반복 작업이 조건을 확인한 결과의 이유(확인한
  페이지 내용을 보고 AI가 쓴 글, 자동 로그인 값은 가림, 1000자까지)도 함께 갑니다. 이 글에는 페이지의 글자가 들어갈 수 있고 텔레그램 서버에 남습니다.
  텔레그램을 연결해 두면, 패널에서 결과를 텔레그램으로 보내 달라고 요청했을 때 AI가 쓴 그 글(자동 로그인 값은 가림, 8000자까지)이 연결한 채팅으로 갑니다.
  이 글에는 페이지의 글자(편집 중인 글자 포함 가능)가 들어갈 수 있고 텔레그램 서버에 남습니다. 실행 방식이 '모든 동작에 승인'이면 보내기 전에 글 전체를 보여 줍니다.
- **MCP 연동**: 최종 답과 승인 질문(위 텔레그램과 같은 범위)이 이 컴퓨터의 다리 프로그램(127.0.0.1, 암호화)을 거쳐 사용자가 등록한 AI 도구로 갑니다. "MCP 클라이언트가 묻지 못하면 텔레그램으로 묻기"를 켜면 그 승인 질문과 MCP 요청 글 앞부분(120자)이 텔레그램으로 갑니다.
  그 도구가 자기 AI 서비스로 보낼 수 있습니다.
- **자동 로그인(KeePassXC)**: 이 컴퓨터의 KeePassXC에서 아이디·비밀번호(켠 사이트는 일회용 코드)를 받아 그 로그인 페이지의 칸에 넣고
  제출합니다. 값은 그 페이지가 제출하는 곳으로 갑니다. 승인한 사이트에서도 다른 출처로 제출하는 양식은 승인 카드로 묻고, 사용자가 승인하면
  실행합니다. 이 값은 AI 서비스로 보내지 않으며, AI 서비스로 보내는 글에서 가리려고 브라우저를 끌 때까지 `chrome.storage.session`
  (메모리, 디스크에 쓰지 않음)에 둡니다.
- **방문 기록에서 찾기**: 누를 때만 `history` 권한을 요청하고, 최근 방문 기록에서 후보를 고릅니다. AI 서비스로는 사용자가 확인 화면에서
  체크한 항목의 제목·사이트와 경로·쿼리 이름만 보냅니다(쿼리 값과 방문 횟수는 보내지 않음).
- **Google 시트·문서·드라이브**: 직접 빌드한 경우만 동작합니다. 사용자가 연결하면 요청한 작업을 하려고 Google API를 부릅니다.

## 3. 이 브라우저에만 저장하는 것

`chrome.storage.local`(이 브라우저 프로필)에만 저장하고 어디로도 보내지 않습니다.

- 설정, AI 서비스의 API 키(암호화하지 않음 — 공용 컴퓨터에서는 쓰지 마세요), 텔레그램 봇 토큰과 최근 요청 5개의 앞부분
- 저장한 링크, 페이지 제안 규칙, 반복 작업
- 동작 기록·읽기 레시피·이동 경로(입력값과 페이지 내용은 남기지 않음, 설정에서 끄거나 지울 수 있음). 이동 경로는 같은 사이트 안에서 답을 마칠 때 거쳐 간 주소 틀(숫자·이름 같은 칸은 자리표시)만 남기며, 같은 사이트에서만 후보로 씀. 읽기 레시피는 설정의 "저장된 읽기 방법 보기"에서 사이트별로 주소 틀·도구·인자·쓴 횟수를 보고 하나씩 또는 사이트째 지울 수 있음(이 목록은 확장 화면에만 보이고 외부로 보내지 않음, 자동 로그인으로 넣은 값이 보이는 항목은 목록에서 뺌)
- KeePassXC 연결 식별 키, MCP 비밀

대화 기록과 진단 로그는 저장하지 않습니다(패널을 닫으면 사라짐). 진단 로그는 사용자가 🐞 → 진단 복사를 누를 때만 클립보드로 복사됩니다.
확장을 삭제하면 위 데이터가 모두 지워집니다. 시크릿 창에서는 저장 링크·동작 기록을 남기지 않습니다.

## 4. Limited Use 준수

이 확장이 받는 사용자 데이터의 사용은 [Chrome 웹 스토어 사용자 데이터 정책](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)과
그 [Limited Use 요건](https://developer.chrome.com/docs/webstore/program-policies/limited-use)을 따릅니다.

- 사용자 데이터는 사용자가 요청하거나 켠 기능을 제공하는 데만 씁니다.
- 판매하지 않고, 광고·신용 판단·대출 심사에 쓰지 않으며, 위에 적은 곳 말고는 넘기지 않습니다.
- 이 프로젝트는 데이터를 받지 않으므로 사람이 읽지 않습니다.
- 분석·추적 도구를 넣지 않습니다.

## 5. 문의와 변경

문의는 [GitHub 이슈](https://github.com/ingki3/simple-browser-plugin/issues)로 남겨 주세요. 이 방침을 바꾸면 이 문서를 고치고
시행일을 바꿉니다. 바뀐 이력은 이 파일의 커밋 기록에서 볼 수 있습니다.

---

<a id="english"></a>

# Privacy Policy (English)

Simple Browser Plugin ("the extension") · Effective 2026-11-05

The extension is open source. This project runs no server that receives user data. The extension sends data only to the
services the user chooses in settings, to do what the user asks. Everything else stays in this browser.

## 1. What is sent to the AI provider

The user picks one AI provider (OpenRouter, OpenAI, Google Gemini, Anthropic Claude, or a local/compatible server whose address the user enters) and enters their own API key (optional for a local server).
With a local/compatible server, the data below goes only to the server at that address. If the address points to another computer (https), whoever runs that server receives it.
To handle a request, the extension sends the following to that provider:

- The conversation: the user's requests, the model's answers, and tool results
- The **full URL (including query and fragment) and title** of the current tab, with every request
- Page content: for summarizing, translating, and reading, the extension reads the page's text. **This can include text in hidden
  elements, text in editable areas, and the initial text of input fields.** Values the user typed into form fields are not included
  in the results of the find, click, and fill tools.
- Files the request needs: the PDF in a PDF tab, attachments or linked documents the user asked to read, and another tab the user chose to read
- The current date, time, and time zone (for example, Asia/Seoul)
- Names, purposes, sites, and placeholder names of saved links (as candidates for reuse)
- If voice input is on: the recorded audio, sent to the speech provider chosen in settings (it can differ from the chat provider). Recordings are not stored.

If OpenRouter is chosen, OpenRouter forwards the data to the company of the chosen model. Each provider handles the data under its
own policy: [OpenRouter](https://openrouter.ai/privacy), [OpenAI](https://openai.com/policies/privacy-policy/),
[Google](https://policies.google.com/privacy), [Anthropic](https://www.anthropic.com/legal/privacy).

### Sending while the user is not in the panel

- **Repeat tasks**: a repeat task that the user approved and registered runs at the chosen interval, without a new request and even
  when the panel is closed. It opens the target page in a background tab and sends the condition and the page's URL, title, text,
  and buttons to the AI provider. To pause or delete it, use Settings → 동작 (Behavior) → 반복 작업 (Repeat tasks).
- **Telegram and MCP requests**: when those optional features are on, requests from them send the same kinds of data to the AI provider.

## 2. Optional features (only when turned on)

- **Telegram**: requests, final answers, approval questions (request text, planned steps, destination URLs, names of targets to click, fields and values to fill (only the length for passwords), addresses of files or links to read or save, the screen to capture),
  and repeat-task alerts go through Telegram's servers to the single Telegram chat the user paired.
- **MCP**: final answers and approval questions (same scope as Telegram above) go through the local bridge on this computer (127.0.0.1, encrypted) to the AI tool the
  user registered. That tool may send them to its own AI service. If "ask via Telegram when the MCP client cannot ask" is on, those approval
  questions and the first 120 characters of the MCP request go to Telegram.
- **Auto sign-in (KeePassXC)**: the extension gets the username and password (and a one-time code, where enabled) from KeePassXC on this
  computer, fills them into that sign-in page, and submits the form. The values go wherever that page submits them. Even on an approved
  site, a form that submits to a different origin needs approval on a card, and runs only if the user approves. These values are never
  sent to the AI provider. To mask them in text sent to the AI provider, they are kept in `chrome.storage.session` (memory only, not
  written to disk) until the browser closes.
- **Find pages from history**: asks for the `history` permission only when used, and picks candidates from recent history. Only the title,
  site and path, and query parameter names of the entries the user checks are sent to the AI provider (no query values or visit counts).
- **Google Sheets, Docs, Drive**: available only in self-built versions. Once the user connects, the extension calls Google APIs to do the requested task.

## 3. Stored only in this browser

Stored in `chrome.storage.local` (this browser profile) and never sent anywhere:

- Settings, the AI provider API key (not encrypted, so avoid shared computers), the Telegram bot token, and the first part of the last 5 Telegram requests
- Saved links, page suggestion rules, repeat tasks
- Action log, read recipes and navigation paths (no typed values or page content; can be turned off or cleared in settings). A navigation path is only the URL patterns visited within one site while answering a request (numbers, names and similar parts are replaced by placeholders), and it is offered again only on that site
- The KeePassXC association key and the MCP secret

Conversations and diagnostic logs are not stored; they disappear when the panel closes. The diagnostic log is copied to the clipboard
only when the user presses 🐞 → 진단 복사 (Copy diagnostics). Removing the extension deletes all of the above. Saved links and the action
log are not recorded in incognito windows.

## 4. Limited Use

The use of information received by the extension adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the
[Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).

- User data is used only to provide features the user asks for or turns on.
- It is not sold, not used for advertising, creditworthiness, or lending, and not transferred anywhere other than the places listed above.
- This project does not receive the data, so no human reads it.
- The extension includes no analytics or tracking.

## 5. Contact and changes

Contact: [GitHub issues](https://github.com/ingki3/simple-browser-plugin/issues). If this policy changes, this document and its
effective date are updated. The change history is in this file's commit history.
