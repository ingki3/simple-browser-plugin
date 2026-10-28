import { PROVIDER_LINKS } from "@/lib/providerLinks";
import { PROVIDER_IDS } from "@/lib/providers/types";
import { KO } from "../i18n/ko";

interface Props {
  needsKey: boolean;
  onOpenSettings: () => void;
  onSend: (text: string) => void;
}

// 빈 대화 화면(#129). 키가 없으면 키 안내와 설정 열기를, 있으면 바로 눌러 볼 첫 작업을 보인다.
export function Welcome({ needsKey, onOpenSettings, onSend }: Props) {
  if (needsKey) {
    return (
      <div className="welcome">
        <strong className="welcome-title">{KO.welcomeKeyTitle}</strong>
        <p>{KO.welcomeKeyBody}</p>
        <p>{KO.welcomeKeyCost}</p>
        <ul className="welcome-providers">
          {PROVIDER_IDS.map((id) => (
            <li key={id}>
              <span>{PROVIDER_LINKS[id].label}</span>
              <a href={PROVIDER_LINKS[id].keyUrl} target="_blank" rel="noopener noreferrer">
                키 발급
              </a>
              <a href={PROVIDER_LINKS[id].pricingUrl} target="_blank" rel="noopener noreferrer">
                요금
              </a>
            </li>
          ))}
        </ul>
        <p className="welcome-note">{KO.welcomeKeyTip}</p>
        <button type="button" className="btn-approve" onClick={onOpenSettings}>
          {KO.welcomeOpenSettings}
        </button>
      </div>
    );
  }
  return (
    <div className="welcome">
      <strong className="welcome-title">{KO.welcomeReadyTitle}</strong>
      <p>{KO.welcomeReadyBody}</p>
      <div className="welcome-examples">
        {KO.welcomeExamples.map((text) => (
          <button key={text} type="button" className="ghost-btn" onClick={() => onSend(text)}>
            {text}
          </button>
        ))}
      </div>
      <p className="welcome-note">{KO.welcomeReadyNote}</p>
    </div>
  );
}
