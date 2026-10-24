import { useEffect, useState } from "react";
import { MAX_MANUAL_SITES, manualSiteOf } from "@/lib/manualSites";

interface Props {
  sites: string[];
  onChange: (sites: string[]) => void;
  // 사이드 패널에서는 지금 탭의 사이트를 바로 추가하는 버튼을 보인다(옵션 페이지에서는 지금 탭이 옵션 페이지라 숨긴다).
  currentTabButton?: boolean;
}

// 직접 조작할 사이트(0.2.2): 이 사이트에서는 도우미가 클릭·입력을 대신하지 않고, 대상을 화면에 표시해 사용자가 직접 한다.
export function ManualSitesField({ sites, onChange, currentTabButton = false }: Props) {
  const [text, setText] = useState("");
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    if (!currentTabButton) return;
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => setCurrent(manualSiteOf(tab?.url)))
      .catch(() => setCurrent(null));
  }, [currentTabButton]);

  const add = (site: string | null) => {
    if (!site || sites.includes(site) || sites.length >= MAX_MANUAL_SITES) return;
    onChange([...sites, site]);
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
              <button type="button" className="ghost-btn" onClick={() => onChange(sites.filter((x) => x !== s))}>
                빼기
              </button>
            </li>
          ))}
        </ul>
      )}
      {currentTabButton && current && !sites.includes(current) && (
        <button type="button" className="ghost-btn" onClick={() => add(current)}>
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
          disabled={!typed || sites.includes(typed)}
          onClick={() => {
            add(typed);
            setText("");
          }}
        >
          추가
        </button>
      </div>
      <span className="field-help">
        이 사이트에서는 도우미가 버튼을 누르거나 칸을 채우지 않고, 할 일을 화면에 표시해 직접 하도록 안내합니다. 표시한 버튼을
        누르거나 패널에서 "했어요"를 누르면 이어서 진행합니다. 자동 조작을 막는 예매 사이트 등에 쓰세요.
      </span>
    </div>
  );
}
