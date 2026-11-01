import { FieldHelp } from "./FieldHelp";
import { useEffect, useState } from "react";
import { MAX_MANUAL_SITES, manualSiteOf } from "@/lib/manualSites";
import type { ManualSiteOp } from "@/lib/settingsOps";

interface Props {
  // 저장된 목록(useSettings가 따라감). 바꾸기는 항목 하나씩 백그라운드에 보내 그때의 저장 목록에 적용한다(#127 — 옛 목록 전체를
  // 저장해 다른 곳에서 넣은 사이트를 지우지 않게).
  sites: string[];
  // 사이드 패널에서는 지금 탭의 사이트를 바로 추가하는 버튼을 보인다(옵션 페이지에서는 지금 탭이 옵션 페이지라 숨긴다).
  currentTabButton?: boolean;
}

// 직접 조작할 사이트(0.2.2): 이 사이트에서는 도우미가 클릭·입력을 대신하지 않고, 대상을 화면에 표시해 사용자가 직접 한다.
export function ManualSitesField({ sites, currentTabButton = false }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    if (!currentTabButton) return;
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => setCurrent(manualSiteOf(tab?.url)))
      .catch(() => setCurrent(null));
  }, [currentTabButton]);

  const send = async (op: ManualSiteOp): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage({ kind: "manual_site_op", op })) as { ok?: boolean; error?: string } | undefined;
      if (!res?.ok) throw new Error(res?.error ?? "응답이 없습니다.");
      return true;
    } catch (err) {
      setError(`직접 조작할 사이트를 바꾸지 못했습니다(${err instanceof Error ? err.message : String(err)}).`);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = (site: string | null) => {
    if (!site || sites.includes(site) || sites.length >= MAX_MANUAL_SITES) return Promise.resolve(false);
    return send({ op: "add", site });
  };
  const typed = manualSiteOf(text.trim()) ?? manualSiteOf(`https://${text.trim()}`);

  return (
    <div className="field">
      <span className="field-label">직접 조작할 사이트</span>
      {sites.length > 0 && (
        <ul className="site-list">
          {sites.map((s) => (
            <li key={s} className="key-row">
              <span className="site-name">{s}</span>
              <button type="button" className="ghost-btn" disabled={busy} onClick={() => void send({ op: "remove", site: s })}>
                빼기
              </button>
            </li>
          ))}
        </ul>
      )}
      {currentTabButton && current && !sites.includes(current) && (
        <button type="button" className="ghost-btn" disabled={busy} onClick={() => void add(current)}>
          지금 탭의 사이트 추가({current})
        </button>
      )}
      <div className="key-row">
        <input
          type="text"
          placeholder="예: etk.srail.kr"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          className="ghost-btn"
          disabled={busy || !typed || sites.includes(typed)}
          onClick={() => {
            void add(typed).then((ok) => {
              if (ok) setText("");
            });
          }}
        >
          추가
        </button>
      </div>
      {error && <span className="field-error">{error}</span>}
      <FieldHelp summary="이 사이트에서는 도우미가 누르거나 채우지 않고, 할 일을 표시해 직접 하도록 안내합니다.">
        이 사이트에서는 도우미가 버튼을 누르거나 칸을 채우지 않고, 할 일을 화면에 표시해 직접 하도록 안내합니다. 표시한 버튼을
        누르거나 패널에서 "했어요"를 누르면 이어서 진행합니다. 자동 조작을 막는 예매 사이트 등에 쓰세요.
      </FieldHelp>
    </div>
  );
}
