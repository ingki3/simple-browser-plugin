# Simple Browser Plugin (간편 브라우저 도우미)

A Chrome side-panel assistant you talk to. It reads the page you are on, summarizes and translates it, fills in forms, clicks buttons, and reads or saves files for you.
You choose the AI model: OpenRouter (many vendors), OpenAI, Google Gemini, Anthropic Claude, or a local LLM on your computer (Ollama, LM Studio, and others; see the [install guide](docs/install.md#로컬-llm선택)).

**[Download the latest release](https://github.com/ingki3/simple-browser-plugin/releases/latest)** · [Install guide (Korean)](docs/install.md) · [한국어](README.md) · Chrome 116+ · MIT license

> The stable version is on Releases (`main` branch). The repository's default branch `dev` is work in progress.
> **The user interface is Korean only.** You can still ask in English. Answers usually follow your language. To make sure, add "Always answer in English." under 설정 → 고급 → 항상 지킬 요청 (Settings → Advanced → Standing request).

## What it can do

| What you want | Try saying |
|---|---|
| Read and summarize | "Summarize this page in three lines.", "When does the video talk about price?" (YouTube) |
| Translate | "Translate this page into English." |
| Read files | "Summarize this paper." (PDF tab), "Summarize the attached HWP file in this notice.", "Organize the Excel file on this page." |
| Fill, click, navigate | "Fill in the empty fields. Name: Hong Gildong", "Sort the filter by newest.", "Check my delivery status." |
| Save | "Save product photos 3 through 5.", "Download only the PDF attachments.", "Capture the whole page." |
| Repeat checks | "Check this page every 10 minutes and book two R seats when tickets open." Approve the registration card and it checks at the set interval and tells you when the condition is met. Booking starts when you press "이어서 진행" (Continue). |
| Telegram | Connect a Telegram bot in settings, then send "Tell me today's weather on naver.com" from your phone and get the answer in Telegram. For actions that need approval, such as navigating, clicking, or filling in, it asks once per request with [승인][거절] (Approve/Reject) buttons whether to hand the task over. Once you do, it continues without asking (payments and deletion included) until that request ends. Auto sign-in, opening saved links, registering repeat tasks, and remembering pages are not done from remote requests. |
| Other AI tools (MCP) | Register the bundled MCP bridge in Claude Code or Claude Desktop, and that AI can give the browser tasks such as "Find today's exchange rate on naver.com" and get the answer. Actions that need approval are not done. If you turn it on in settings, navigating, clicking, filling in, reading files, saving, capturing, and reading links are asked through that AI tool's question dialog (only tools that support it). Without a dialog, it can ask with Telegram buttons instead. Sites you pick under 설정 → 사이트 (Settings → Sites) are visited without asking for MCP requests too. Auto sign-in, opening saved links, registering repeat tasks, and remembering pages are not done. The registration command is under 설정 → 모델·연결 → MCP 연동 (Settings → Model & connections → MCP). |
| Reuse | Save a search page you use often with the 📌 button at the top of the panel (or "Remember this page"). Next time you say something like "Find the lowest MacBook price", it opens that link. |
| Voice input | Press 🎤 in the input box and speak. It turns your speech into text and sends it right away (turn this off in settings to only put the text in the box). First pick the speech model (OpenRouter, ChatGPT, Gemini) under 설정 → 동작 → 음성 입력 (Settings → Behavior → Voice input). |
| Page suggestions | Register a request you make often (for example, translating Medium posts) with "이 페이지에서 제안" (Suggest on this page). When you open a page of the same shape, a suggestion appears above the input box, and pressing it runs the request. |

Optional features
- **Auto sign-in**: signs in with accounts stored in KeePassXC. It needs KeePassXC and a one-time connection setup. See the [install guide](docs/install.md#자동-로그인keepassxc-선택).
- **Google Sheets, Docs, Drive**: requires your own build. See the [install guide](docs/install.md#google-연동선택-직접-빌드-필요).

## Install

1. Download `simple-browser-plugin-vX.X.XX.zip` from [Releases](https://github.com/ingki3/simple-browser-plugin/releases/latest) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, and choose the unzipped folder with **Load unpacked**.
3. Pin **간편 브라우저 도우미** from the puzzle-piece button in the toolbar, then click its icon to open the side panel.

Updating, the meaning of the permissions shown at install, setting up Telegram, MCP, auto sign-in, and Google, and building it yourself are in the [install guide](docs/install.md) (Korean).

## First run

1. When you first open the panel, it shows an API key notice. Pick one service from the table below and get a key. With a local LLM on your computer (Ollama, LM Studio, and others), you need only the server address and a model instead of a key (server setup is in the [install guide](docs/install.md#로컬-llm선택)).
2. Press **설정 열기** (Open settings; ⚙ at the top of the panel does the same). Settings open in a new browser tab. Under **모델·연결** (Model & connections), pick the model provider, enter the key, and press **저장** (Save). For a local/compatible server, enter the server address and model. Changes in settings apply to the open panel right away.
3. Press **연결 확인** (Check connection). It sends one short request to check that the key (or server address) and model work.
4. Open any web page and send "Summarize this page in three lines."

If you are not sure which model to use, keep the default. If you pick one yourself, it must support tool calling.

## API keys and cost

The extension itself is free. You pay the service you chose for the AI usage, separately from any monthly ChatGPT, Gemini, or Claude app subscription. A local LLM on your computer has no fee.

| Service | Get a key | Pricing | Usage |
|---|---|---|---|
| OpenRouter (recommended to start, one key for many vendors' models) | [openrouter.ai/keys](https://openrouter.ai/keys) | [Per-model pricing](https://openrouter.ai/models) | [Activity](https://openrouter.ai/activity) |
| OpenAI | [API keys](https://platform.openai.com/api-keys) | [Pricing](https://openai.com/api/pricing/) | [Usage](https://platform.openai.com/usage) |
| Google Gemini | [AI Studio](https://aistudio.google.com/apikey) | [Pricing](https://ai.google.dev/gemini-api/docs/pricing) | [AI Studio](https://aistudio.google.com/) |
| Anthropic Claude | [Console](https://console.anthropic.com/settings/keys) | [Pricing](https://www.anthropic.com/pricing#api) | [Usage](https://console.anthropic.com/usage) |
| Local LLM (Ollama, LM Studio, and others) | Not needed (only if your server asks for one); see the [install guide](docs/install.md#로컬-llm선택) | None | — |

- Cost depends on the text you send (the conversation and page content) and the length of the answers. Long pages and many-step tasks cost more.
- Set a **spending limit** where you got the key to avoid spending more than you expect.
- The key is stored only in this browser (`chrome.storage.local`) and used only to call the service you chose. It is not encrypted, so do not use it on a shared computer.

## Run mode

Choose below the input box when the assistant asks before actions that change the page (navigating, clicking, filling in, saving).

| Run mode | Behavior |
|---|---|
| 모든 동작에 승인 후 실행 (Approve every action, default) | Shows a card for each action and runs it only after you approve |
| 페이지 이동·클릭·입력을 묻지 않고 실행 (Run without asking) | Runs most actions right away. Risky actions such as payments, submitting personal data, deletion, and leaving the site still ask |
| 처음에 승인 받고 끝까지 실행 (Approve once, then run to the end) | Shows the task and its risks once at the start. Once you hand it over, it does not ask again until the conversation ends, **including payments and deletion**. Use it only for tasks and sites you trust |

For sites that block automation, add them under 설정 → 사이트 → **직접 조작할 사이트** (Settings → Sites → Sites I operate myself; you can pick from open tabs). The assistant then marks where to click and you click it yourself.

## Privacy and safety

- **Where data goes**: the conversation and page content go only to the AI service you chose in settings (OpenRouter forwards them to the chosen model's company; a local/compatible server receives them only at the address you entered). There is no project server.
  If you turn on Telegram or MCP, the answers and approval questions for those requests go there too.
- **What is sent**
  - The current tab's full URL (including the query) and title: with every request
  - Page content: the page's text when summarizing, translating, or reading. It can include text that is not visible on screen or text in editable areas.
  - Files the request needs: the PDF file of a PDF tab, attachments you asked to read
  - The current date and time zone
  - When a whole PDF file is sent, the panel tells you.
  - Registered repeat tasks read and send their target page at the set interval even when the panel is closed (stop or delete them under 설정 → 동작 → 반복 작업, Settings → Behavior → Repeat tasks).
- **What is not sent**
  - Values you typed into form fields: not included in the results of the find, click, and fill tools.
  - Auto sign-in user names and passwords: never sent to the AI service; they are only entered and submitted on that sign-in page.
  - API keys: not sent anywhere except the service you chose.
- **Hidden instructions on pages**: a web page can hide text meant to trick the AI. So in a conversation that has read an external file, every action that changes the page asks first. The exception is while you have handed the task over with "처음에 승인 받고 끝까지 실행" (Approve once, then run to the end).
- **What stays only in this browser**: settings, saved links, and the action log. The action log does not keep typed values or page content, and you can turn it off or clear it in settings.

Full details are in the [Privacy Policy](docs/privacy.md#english); implementation rules are in the [security and privacy details](docs/security.md) (Korean).

## Troubleshooting

| Symptom | Try this |
|---|---|
| "API 키가 맞지 않거나…" (API key is wrong…) | Paste the key again in settings, save, and press **연결 확인** (Check connection) |
| "잔액이 부족합니다" (Insufficient balance), "사용 한도에 닿았습니다" (Usage limit reached) | Top up or check the limit where you got the key |
| The page cannot be read, or no response | Reload that page. Pages that were open before you installed or updated the extension must be reloaded |
| `chrome://` pages, the Chrome Web Store | Chrome blocks extensions on these pages, so they cannot be read |
| The site does not react when a button is pressed | Turn on 설정 → 동작 → **실제 마우스 입력으로 클릭** (Settings → Behavior → Click with real mouse input), or add the site to 설정 → 사이트 → **직접 조작할 사이트** (Sites I operate myself) |
| You use another PDF viewer extension | The address changes to `chrome-extension://` and cannot be read. Open the PDF in Chrome's built-in viewer |
| Anything else | Copy the log with 🐞 (diagnostics for bug reports) → **진단 복사** (Copy diagnostics) and paste it into an [issue](https://github.com/ingki3/simple-browser-plugin/issues/new/choose). It may include URLs you visited, so check it before posting |

## Development and contributing

Developer docs are in Korean.

- [CONTRIBUTING](CONTRIBUTING.md): development setup, tests, PR process
- [Architecture](docs/architecture.md)
- [Feature details](docs/features.md): behavior rules and decision records for each feature
- [Security and privacy details](docs/security.md)
- [Privacy Policy](docs/privacy.md)
- [Chrome Web Store listing materials](docs/webstore.md)

## License

MIT — [LICENSE](LICENSE). Bundled third-party components (pdf.js, kordoc, and others) follow their own licenses.
