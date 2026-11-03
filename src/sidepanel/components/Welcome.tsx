import { PROVIDER_LINKS } from "@/lib/providerLinks";
import { PRIVACY_POLICY_URL } from "@/lib/projectLinks";
import { PROVIDER_IDS } from "@/lib/providers/types";
import { KO } from "../i18n/ko";

interface Props {
  needsKey: boolean;
  onOpenSettings: () => void;
  onSend: (text: string) => void;
}

// 무엇을 어디로 보내는지 — 두 화면 모두 제목·첫 설명 바로 뒤에 둔다(처음 쓰기 전에 보이게).
function PrivacyNote() {
  return (
    <p className="welcome-privacy">
      {KO.welcomePrivacy}{" "}
      <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer">
        {KO.welcomePrivacyLink}
      </a>
    </p>
  );
}

// 빈 대화 화면(#129). 키가 없으면 키 안내와 설정 열기를, 있으면 바로 눌러 볼 첫 작업을 보인다.
export function Welcome({ needsKey, onOpenSettings, onSend }: Props) {
  if (needsKey) {
    return (
      <div className="welcome">
        <strong className="welcome-title">{KO.welcomeKeyTitle}</strong>
        <p>{KO.welcomeKeyBody}</p>
        <PrivacyNote />
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
      <PrivacyNote />
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
