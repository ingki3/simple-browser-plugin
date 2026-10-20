import { useState } from "react";
import type { ChatMessage } from "../state/chatStore";

type Props = Extract<ChatMessage, { type: "page_offer" }>;

// "이 페이지 기억하기"(#30): 사용자가 이름을 확인·수정해 저장한다. 주소에 결제·개인정보 단서가 보이면 한 번 더 확인.
export function PageOfferCard({ offer }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(offer.title);
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  const save = async () => {
    setState("saving");
    try {
      const res = (await chrome.runtime.sendMessage({
        kind: "save_page",
        offerId: offer.offerId,
        name,
        confirmedWarning: confirmed,
      })) as { ok: boolean; error?: string } | undefined;
      if (res?.ok) setState("saved");
      else {
        setError(res?.error ?? "저장하지 못했습니다.");
        setState("error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  };

  if (state === "saved") return <div className="page-offer saved">✓ '{name}' 페이지를 기억했습니다.</div>;
  if (!open) {
    return (
      <div className="page-offer">
        <button type="button" className="ghost-btn" onClick={() => setOpen(true)}>
          이 페이지 기억하기
        </button>
      </div>
    );
  }
  return (
    <div className="page-offer open">
      <label className="field">
        <span className="field-label">이름</span>
        <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="page-offer-url">{offer.url}</div>
      {offer.warning && (
        <label className="check-row page-offer-warn">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>⚠ 이 주소에 {offer.warning} 단서가 있어 보입니다. 그래도 저장합니다.</span>
        </label>
      )}
      <span className="field-help">
        저장한 이름과 주소는 같은 사이트에서 도우미를 쓸 때 모델(OpenRouter)에 이동 후보로 전송됩니다. 설정에서 지울 수 있습니다.
      </span>
      {state === "error" && <span className="field-help error-text">{error}</span>}
      <div className="page-offer-actions">
        <button type="button" className="btn-cancel" onClick={() => setOpen(false)}>
          취소
        </button>
        <button
          type="button"
          className="btn-approve"
          disabled={state === "saving" || !name.trim() || (!!offer.warning && !confirmed)}
          onClick={save}
        >
          저장
        </button>
      </div>
    </div>
  );
}
