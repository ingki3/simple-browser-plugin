import { useState } from "react";
import { RUN_MODES, isRunMode } from "@/lib/messages";
import { KO } from "../i18n/ko";
import { useSettings } from "../hooks/useSettings";

// 입력창 아래의 실행 방식 선택(#123). 설정 → 동작의 실행 방식과 같은 값이며, 바꾸면 바로 저장한다.
export function RunModeSelect() {
  const { settings, loaded, savePatch } = useSettings();
  // 저장하지 못하면 알린다(#130). 선택은 저장된 값으로 돌아가 있으므로 지금 방식을 함께 보인다.
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {error && (
        <div className="composer-hint" role="alert">
          실행 방식을 바꾸지 못했습니다({error}). 지금 방식: {KO.runModeLabels[settings.runMode]}
        </div>
      )}
      <div className="run-mode-row">
        <label className="run-mode-label" htmlFor="run-mode-select">
          {KO.runModeLabel}
        </label>
        <select
          id="run-mode-select"
          className="run-mode-select"
          value={settings.runMode}
          disabled={!loaded}
          title={KO.runModeHelp[settings.runMode]}
          onChange={(e) => {
            const runMode = e.target.value;
            if (!isRunMode(runMode)) return;
            setError(null);
            void savePatch({ runMode }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
          }}
        >
          {RUN_MODES.map((m) => (
            <option key={m} value={m}>
              {KO.runModeLabels[m]}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
