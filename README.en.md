# Simple Browser Plugin (간편 브라우저 도우미)

A Chrome side-panel assistant you talk to. It reads the page you are on, summarizes and translates it, fills in forms, clicks buttons, and reads or saves files for you.
You bring your own AI model: OpenRouter (many vendors), OpenAI, Google Gemini, Anthropic Claude, or a local LLM on your computer (Ollama, LM Studio, and other OpenAI-compatible servers).

**[Download the latest release](https://github.com/ingki3/simple-browser-plugin/releases/latest)** · Chrome 116+ · MIT license

> **The user interface is Korean only.** You can still ask in English. Answers usually follow your language. To make sure, add "Always answer in English." under 설정 → 고급 → 항상 지킬 요청 (Settings → Advanced → Standing request). Page translation can target any language.
> The stable version is on Releases (`main` branch). The default branch `dev` is work in progress.

## Install

1. Download `simple-browser-plugin-vX.X.XX.zip` from [Releases](https://github.com/ingki3/simple-browser-plugin/releases/latest) and unzip it somewhere permanent.
   Use this file, not "Source code".
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the unzipped folder. It is the folder that contains `manifest.json`.
3. Pin **간편 브라우저 도우미** from the puzzle-piece menu and click its icon to open the side panel.

To update, replace the folder's contents with the new release, press the reload (↻) button on `chrome://extensions`, and reload open tabs.
Keep the same folder path, or Chrome treats it as a new extension and your settings start empty.

Chrome warns that the extension can "read and change all your data on all websites". It needs this to read and operate the page you ask about.
The permission table in the [Korean install guide](docs/install.md#권한) explains each permission.

## First run

1. Get an API key from one provider:
   - [OpenRouter](https://openrouter.ai/keys), recommended (one key, many models)
   - [OpenAI](https://platform.openai.com/api-keys)
   - [Google AI Studio](https://aistudio.google.com/apikey)
   - [Anthropic Console](https://console.anthropic.com/settings/keys)
2. In the panel, click **설정 열기** (Open settings) or ⚙ at the top. Settings open in a new browser tab, and changes apply to the open panel right away.
3. Under **모델·연결** (Model & connections), pick the provider under **모델 제공자**, paste the key, and press **저장** (Save).
4. Press **연결 확인** (Check connection). It sends one tiny request.
5. Open any web page and send "Summarize this page in three lines."

## Optional features

All are set up in settings. Step-by-step instructions are in the [Korean install guide](docs/install.md).

- **Telegram** (모델·연결 → 텔레그램): send tasks from your phone to a bot paired with your own chat. For actions that need approval, it asks once per request with [승인][거절] (Approve/Reject) buttons.
- **MCP** (모델·연결 → MCP): let Claude Code, Claude Desktop, or another MCP client give the browser tasks through the bundled bridge `mcp/sbp-mcp.mjs` (Node.js 22+).
- **Voice input** (동작 → 음성 입력): press 🎤 and speak. Pick a speech model first.
- **Auto sign-in** (사이트 → KeePassXC): signs in with accounts stored in [KeePassXC](https://keepassxc.org/). Needs a one-time native messaging setup.
- **Google Sheets, Docs, Drive**: requires your own build with an OAuth client ID.

## Cost

The extension is free. You pay your AI provider for usage, separately from any ChatGPT, Gemini, or Claude app subscription.
Cost grows with the amount of text sent and received, so long pages and many-step tasks cost more.
Set a spending limit at your provider. Your key is stored unencrypted in this browser's `chrome.storage.local`, so avoid shared computers.

## Safety

- **Where data goes**: chat and page content go only to the provider you chose (OpenRouter forwards to the chosen model's company; a local/compatible server receives them only at the address you entered). There is no project server.
  If you turn on Telegram or MCP, answers and approval questions for those requests also go there.
- **What is sent**: the current tab's full URL and title with every request, and page text when reading, summarizing, or translating. Page text can include hidden text and text in editable areas.
  Registered repeat tasks read their target page at the set interval even when the panel is closed.
- **What is not sent**: values you typed into form fields are not sent in the results of the find, click, and fill tools. Auto sign-in credentials are never sent to the AI provider.
- Full details: [Privacy Policy](docs/privacy.md#english).
- **Run mode** (실행 방식, below the input box) decides when the assistant asks before acting:
  - **모든 동작에 승인 후 실행** (default): asks before every navigation, click, input, or save.
  - **페이지 이동·클릭·입력을 묻지 않고 실행**: acts directly, but still asks for payments, personal-data submission, deletion, and leaving the site.
  - **처음에 승인 받고 끝까지 실행**: asks once at the start. After that it does not ask again until the conversation ends, **including payments and deletion**. Use it only for tasks and sites you trust.
- **Hidden instructions**: a web page can hide text meant to trick the AI. Prefer the default run mode on unfamiliar sites.

## Help

Use 🐞 → **진단 복사** (Copy diagnostics) and paste the log into an [issue](https://github.com/ingki3/simple-browser-plugin/issues/new/choose).
The log may include URLs you visited, so check it before posting.

Developer docs are in Korean: [CONTRIBUTING](CONTRIBUTING.md), [architecture](docs/architecture.md).
