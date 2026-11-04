// 보낼 대상 고정(#193). 모델 요청은 시작할 때의 대상(제공자·키·모델·로컬 서버 주소)으로만 보낸다 — 고른 제공자로만 보낸다는 약속.
// 요청을 준비하는 사이(가림 처리 등) 설정에서 대상이 바뀌면 그 요청을 새 대상으로도, 옛 대상으로도 보내지 않는다.
// 쓰는 법: const g = beginTargetGuard(active) → 모든 준비(await)를 마친 뒤 await g.verify() → 다음 줄에서 바로 adapter.complete/openStream(…, g.signal)
// (어댑터는 첫 await 전에 fetch를 시작한다) → 결과를 받은 직후 g.assert() → 끝나면 g.end(). 대상이 바뀌면 진행 중인 요청도 abort한다.
import { activeModel, normalizeSettings, targetKey, type ActiveModel } from "@/lib/settings";
import type { Settings } from "@/lib/messages";
import { getSettings } from "./storage";

export const TARGET_CHANGED_MESSAGE =
  "설정에서 모델 제공자·API 키·모델·서버 주소가 바뀌어 이 요청을 보내지 않았습니다. 다시 요청하면 새 설정으로 보냅니다.";

export class TargetChangedError extends Error {
  constructor() {
    super(TARGET_CHANGED_MESSAGE);
    this.name = "TargetChangedError";
  }
}

interface Guard {
  key: string;
  controller: AbortController;
  changed: boolean;
}

const guards = new Set<Guard>();

// 설정 저장소가 바뀌면 다른 대상을 붙잡은 가드를 모두 멈춘다.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("settings" in changes)) return;
  const key = targetKey(activeModel(normalizeSettings(changes.settings.newValue as Partial<Settings> | undefined)));
  for (const g of guards) {
    if (g.key === key || g.changed) continue;
    g.changed = true;
    g.controller.abort();
  }
});

export interface TargetGuard {
  // 이 가드의 중단 신호(바깥 신호와 묶임). 어댑터 호출에 넘긴다.
  signal: AbortSignal;
  // 지금 설정의 대상이 같은지 읽어 본다(다르면 던진다). 이 다음 줄에서 바로 요청한다.
  verify(): Promise<void>;
  // 기다림 없이 확인(결과를 받은 직후 등). 바뀌었으면 던진다.
  assert(): void;
  changed(): boolean;
  end(): void;
}

export function beginTargetGuard(active: Pick<ActiveModel, "provider" | "apiKey" | "model" | "baseUrl">, outer?: AbortSignal): TargetGuard {
  const g: Guard = { key: targetKey(active), controller: new AbortController(), changed: false };
  guards.add(g);
  const signal = outer ? AbortSignal.any([outer, g.controller.signal]) : g.controller.signal;
  const assert = () => {
    if (g.changed) throw new TargetChangedError();
  };
  return {
    signal,
    async verify() {
      const now = targetKey(activeModel(await getSettings()));
      if (now !== g.key && !g.changed) {
        g.changed = true;
        g.controller.abort();
      }
      assert();
    },
    assert,
    changed: () => g.changed,
    end: () => {
      guards.delete(g);
    },
  };
}
