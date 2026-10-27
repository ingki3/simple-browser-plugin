import { RUN_MODES, isRunMode } from "@/lib/messages";
import { KO } from "../i18n/ko";
import { useSettings } from "../hooks/useSettings";

// 입력창 아래의 실행 방식 선택(#123). 설정 → 동작의 실행 방식과 같은 값이며, 바꾸면 바로 저장한다.
export function RunModeSelect() {
  const { settings, loaded, savePatch } = useSettings();
  return (
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
          if (isRunMode(runMode)) void savePatch({ runMode }).catch(() => undefined);
        }}
      >
        {RUN_MODES.map((m) => (
          <option key={m} value={m}>
            {KO.runModeLabels[m]}
          </option>
        ))}
      </select>
    </div>
  );
}
