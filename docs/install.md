# 설치와 업데이트

빌드할 필요 없이, 릴리스의 설치용 ZIP으로 설치합니다. Chrome 116 이상(데스크톱)에서 동작합니다.

## 준비물

- Chrome 116 이상. Edge 같은 Chromium 브라우저도 압축해제 확장을 불러올 수 있지만, 확인은 Chrome에서만 했습니다.
- AI 서비스의 API 키 하나. 다음 중 하나를 고릅니다(자세한 발급·요금 안내는 [README](../README.md#api-키와-비용)).
  - OpenRouter(여러 회사 모델을 키 하나로)
  - OpenAI
  - Google Gemini
  - Anthropic Claude

## 설치

1. [Releases](https://github.com/ingki3/simple-browser-plugin/releases/latest)에서 `simple-browser-plugin-vX.X.XX.zip`을 받습니다.
   "Source code"가 아니라 이름이 `simple-browser-plugin-`으로 시작하는 파일입니다.
2. ZIP을 풀고, 나온 `simple-browser-plugin-vX.X.XX` 폴더를 지우지 않을 곳(예: 문서 폴더)에 둡니다.
   Chrome은 이 폴더에서 확장을 읽으므로, 폴더를 지우거나 옮기면 확장이 사라집니다.
3. 주소창에 `chrome://extensions`를 열고, 오른쪽 위의 **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램 로드**를 눌러, 2에서 둔 폴더를 고릅니다. `manifest.json`이 들어 있는 폴더입니다.
5. 도구 모음의 퍼즐 조각(확장 프로그램) 버튼을 누르고, **간편 브라우저 도우미** 옆의 핀을 눌러 고정합니다.
6. 고정한 아이콘을 누르면 오른쪽에 사이드 패널이 열립니다. 처음 열면 API 키를 넣는 안내가 보입니다.

설치하면 Chrome이 "모든 웹사이트의 데이터 읽기 및 변경" 같은 권한을 알립니다. 무엇에 쓰는지는 [아래 표](#권한)를 보세요.

## 업데이트

1. 새 버전의 ZIP을 받아 풉니다.
2. 기존 폴더의 내용을 새 폴더의 내용으로 바꿉니다. 같은 폴더 경로를 써야 설정과 저장한 링크가 그대로 남습니다.
3. `chrome://extensions`에서 이 확장의 새로고침(↻) 버튼을 누릅니다.
4. 이미 열려 있던 웹 페이지는 새로고침합니다. 확장을 다시 불러오면 열려 있던 페이지와의 연결이 끊기기 때문입니다.

폴더를 다른 곳으로 옮겨 다시 불러오면 Chrome이 다른 확장으로 보아 설정이 비어 있습니다. 이때는 API 키를 다시 넣습니다.

## 지우기

`chrome://extensions`에서 **삭제**를 누르면 설정·API 키·저장한 링크·동작 기록이 함께 지워집니다. 그 뒤 폴더를 지웁니다.

## 권한

Chrome의 확장 권한은 설치할 때 한꺼번에 알립니다. 각 권한이 언제 쓰이는지는 다음과 같습니다.

| 권한 | 쓰는 곳 | 언제 |
|---|---|---|
| 모든 사이트 접근(`<all_urls>`) | 지금 보는 페이지를 읽고(요약·번역), 입력칸을 채우고, 버튼을 누릅니다. 페이지의 첨부 파일·링크 내용도 읽습니다 | 사이드 패널에서 요청할 때. 페이지를 바꾸는 동작은 실행 방식에 따라 승인 카드로 묻습니다 |
| `sidePanel` | 사이드 패널 화면 | 늘 |
| `storage` | 설정, API 키, 저장한 링크, 동작 기록을 이 브라우저에만 저장 | 늘 |
| `tabs`, `activeTab`, `scripting` | 지금 탭을 알고, 페이지에 도우미 스크립트를 넣고, 새 탭을 따라갑니다 | 요청할 때 |
| `webNavigation` | 이동·클릭 뒤 페이지가 다 열릴 때까지 기다립니다 | 요청할 때 |
| `downloads` | 이미지·첨부 파일·화면 캡처 저장 | 저장을 요청할 때 |
| `webRequest` | 파일을 읽을 때 다른 주소로 넘어가는지(리다이렉트) 확인만 합니다. 요청을 바꾸거나 막지 않습니다 | 파일·링크를 읽을 때 |
| `offscreen` | 문서 변환(PDF·한글·Office)과 캡처 이어 붙이기를 보이지 않는 창에서 처리 | 파일을 읽거나 전체 캡처할 때 |
| `alarms` | 긴 작업 중 백그라운드가 잠들지 않게 함 | 작업 중 |
| `identity` | Google 계정 연결(시트·문서·드라이브) | 설정에서 연결할 때만. 직접 빌드한 경우만 동작(아래) |
| `debugger` | **실제 마우스 입력으로 클릭**. 스크립트 클릭에 반응하지 않는 사이트용 | 설정 → 동작에서 켰을 때만. 누르는 동안 "디버깅 중" 막대가 뜹니다. Chrome이 이 권한을 나중에 요청하는 방식을 허용하지 않아 설치 때 함께 알립니다 |
| `nativeMessaging`(선택) | KeePassXC 자동 로그인 | 설정에서 켤 때 따로 묻습니다 |

대화와 페이지 내용은 설정에서 고른 AI 서비스 한 곳으로만 보냅니다. 다른 서버로 보내는 일은 없습니다.

## 텔레그램 연동(선택)

1. 텔레그램에서 @BotFather에게 `/newbot`을 보내 봇을 만들고 토큰을 받습니다.
2. 패널 설정 → 텔레그램 연동에 토큰을 넣고 저장합니다.
3. "연결하기"를 누르면 여섯 자리 코드가 나옵니다. 텔레그램에서 만든 봇과의 대화에 그 코드를 보냅니다.
4. 연결되면 봇에게 할 일을 보내세요. 브라우저가 켜져 있어야 하고, 받는 데 최대 1분쯤 걸립니다.

승인이 필요한 동작(결제·삭제·개인정보 입력·로그인·저장, 요청에 적지 않은 사이트로 이동)은 하지 않습니다. 토큰이 새어 나갔다면 @BotFather에서 `/revoke`로 폐기하세요.

## MCP 연동(선택, Claude Code·Claude Desktop 등)

다른 AI 도구가 이 도우미에게 브라우저 일을 시키고 답을 받게 합니다. [Node.js](https://nodejs.org/) 22 이상이 필요합니다.

1. 패널 설정 → MCP 연동에서 "MCP 연동 켜기"를 누르고 "비밀 보기"로 비밀을 확인합니다.
2. 받은 ZIP을 푼 폴더(직접 빌드했다면 저장소)의 `mcp/sbp-mcp.mjs`가 다리 프로그램입니다. AI 도구에 등록합니다. 설정 화면에 비밀이 채워진 예시가 있습니다.
   - Claude Code: `claude mcp add simple-browser -e SBP_SECRET=<비밀> -- node "<폴더>/mcp/sbp-mcp.mjs"`
   - Claude Desktop: `claude_desktop_config.json`의 `mcpServers`에 `command`(node의 절대 경로, 예: `/usr/local/bin/node`), `args`(다리 파일 경로), `env.SBP_SECRET`을 넣습니다. 경로에 빈칸이 있으면 그대로 따옴표 안에 둡니다.
3. AI 도구에서 다리가 실행되면 설정에 "다리와 연결됨"이 보입니다. 이제 그 AI에게 "브라우저로 naver.com에서 오늘 환율 찾아 줘"처럼 시키면 됩니다.

- 기본 포트는 47615입니다. 다른 프로그램이 쓰고 있으면 설정의 포트와 다리의 `SBP_PORT`를 같은 값으로 바꾸세요.
- 확장을 업데이트하면 다리 파일도 새 ZIP의 것으로 바꾸세요.
- 처리 방식은 텔레그램과 같습니다(승인이 필요한 동작은 하지 않음). 답은 그 AI 도구로 가고, 그 도구가 자기 AI 서비스로 보낼 수 있습니다.

## Google 연동(선택, 직접 빌드 필요)

Google 시트·문서·드라이브 도구는 **기본 사용에 필요 없는 선택 기능**이고, 릴리스 ZIP에서는 꺼져 있습니다.
쓰려면 자기 Google Cloud 프로젝트의 OAuth 클라이언트 ID를 넣어 직접 빌드해야 합니다.

1. 아래 "직접 빌드"대로 한 번 빌드하고 `dist/`를 불러와, `chrome://extensions`에서 확장 ID를 확인합니다.
2. [Google Cloud 콘솔](https://console.cloud.google.com/apis/library)에서 Sheets·Docs·Drive API를 켜고, "OAuth 동의 화면"을 구성해 자기 이메일을 테스트 사용자로 등록합니다.
3. "사용자 인증 정보" → "OAuth 클라이언트 ID"를 만듭니다. 애플리케이션 유형은 "Chrome 확장 프로그램", Application ID는 1의 확장 ID입니다.
4. `GOOGLE_OAUTH_CLIENT_ID=<클라이언트 ID> npm run build`로 다시 빌드하고 확장을 새로고침합니다.
5. 설정 → 연결에서 Google에 연결합니다.

확장 ID는 불러온 폴더 경로에 따라 정해지므로, 폴더를 옮기면 3부터 다시 해야 합니다.

## 직접 빌드

Node.js 22가 필요합니다.

```bash
git clone https://github.com/ingki3/simple-browser-plugin.git
cd simple-browser-plugin
git checkout main   # 안정 버전. 기본 브랜치 dev는 개발 중인 코드입니다
npm ci
npm run build
```

`dist/` 폴더를 위 설치 4번처럼 불러옵니다.
