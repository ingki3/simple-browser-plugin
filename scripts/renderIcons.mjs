// public/icons/icon.svg를 확장 아이콘 PNG(16·32·48·128)로 그린다. 아이콘을 바꿨을 때만 다시 실행한다.
// 사용법: node scripts/renderIcons.mjs   (하네스와 같은 Chrome for Testing을 쓴다: HARNESS_CHROME 또는 npx playwright-core install chromium)
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { findChrome } from "../tests/harness/lib.mjs";

const dir = path.resolve("public/icons");
const svg = fs.readFileSync(path.join(dir, "icon.svg"), "utf8");
const executablePath = findChrome();
if (!executablePath) throw new Error("Chrome for Testing을 찾지 못했습니다(HARNESS_CHROME).");
const browser = await chromium.launch({ executablePath });
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.screenshot({ path: path.join(dir, `icon-${size}.png`), omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
