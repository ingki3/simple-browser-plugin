import { useRef, useState } from "react";
import { makeTemplate, MAX_PURPOSE, MAX_SLOT_KEY, templateText, type ParamChoice } from "@/lib/savedPages";
import type { ChatMessage } from "../state/chatStore";

type Props = Extract<ChatMessage, { type: "page_offer" }>;

interface Draft {
  name: string;
  purpose: string;
  choices: ParamChoice[];
  hints: Record<string, string>;
}

type Mode = ParamChoice["mode"];

// "이 페이지 기억하기"(#30·#86): 이름·용도를 확인하고, 쿼리 값마다 고정·입력 자리·빼기를 골라 다시 쓸 수 있는 링크로 저장한다.
// 카드를 열면 모델에 초안(이름·용도·값마다 고정·자리·빼기)을 한 번 묻고(이 턴의 요청·답·페이지 글자를 함께 보낸다), 사용자가
// 고쳐 저장한다. 주소에 결제·개인정보 단서가 보이면 초안을 묻지 않고, 저장할 때 한 번 더 확인한다.
export function PageOfferCard({ offer }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(offer.title);
  const [purpose, setPurpose] = useState("");
  const [modes, setModes] = useState<Mode[]>(() => offer.params.map(() => "keep"));
  const [slots, setSlots] = useState<string[]>(() => offer.params.map(() => ""));
  const [hints, setHints] = useState<Record<string, string>>({});
  const [drafting, setDrafting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [evicted, setEvicted] = useState<string | null>(null);
  // 초안을 기다리는 사이 사용자가 고친 칸은 늦게 온 초안으로 덮지 않는다. 카드를 닫았다 다시 열면 이전 요청의 응답은 버린다.
  const touched = useRef({ name: false, purpose: false, params: false, hints: new Set<string>() });
  const draftSeq = useRef(0);

  const choices: ParamChoice[] = modes.map((m, i) => (m === "slot" ? { mode: "slot", slot: slots[i] } : { mode: m }));
  let preview = "";
  let previewError = "";
  try {
    preview = templateText(makeTemplate(offer.url, choices).template);
  } catch (err) {
    previewError = err instanceof Error ? err.message : String(err);
  }
  const slotNames = [...new Set(modes.flatMap((m, i) => (m === "slot" && slots[i].trim() ? [slots[i].trim()] : [])))];

  const openCard = async () => {
    setOpen(true);
    // 결제·개인정보 단서가 보이는 주소는 초안을 묻지 않는다(경로·제목·본문으로도 값이 샐 수 있어 사용자가 직접 정한다).
    if (offer.warning) return;
    const seq = ++draftSeq.current;
    setDrafting(true);
    try {
      const res = (await chrome.runtime.sendMessage({ kind: "saved_link_draft", offerId: offer.offerId })) as
        | { ok: boolean; data?: Draft | null }
        | undefined;
      const d = res?.ok ? res.data : null;
      if (d && seq === draftSeq.current) {
        const t = touched.current;
        if (!t.name) setName(d.name || offer.title);
        if (!t.purpose) setPurpose(d.purpose);
        if (!t.params && d.choices.length === offer.params.length) {
          setModes(d.choices.map((c) => c.mode));
          setSlots(d.choices.map((c) => (c.mode === "slot" ? c.slot : "")));
        }
        setHints((cur) => {
          const next = { ...cur };
          for (const [k, v] of Object.entries(d.hints)) if (!t.hints.has(k)) next[k] = v;
          return next;
        });
      }
    } catch {
      /* 초안 없이 직접 정한다 */
    } finally {
      if (seq === draftSeq.current) setDrafting(false);
    }
  };
  const close = () => {
    draftSeq.current++;
    setDrafting(false);
    setOpen(false);
  };

  const save = async () => {
    setState("saving");
    try {
      const res = (await chrome.runtime.sendMessage({
        kind: "save_page",
        offerId: offer.offerId,
        name,
        purpose,
        choices,
        hints,
        confirmedWarning: confirmed,
      })) as { ok: boolean; data?: { evicted: string | null }; error?: string } | undefined;
      if (res?.ok) {
        setEvicted(res.data?.evicted ?? null);
        setState("saved");
      } else {
        setError(res?.error ?? "저장하지 못했습니다.");
        setState("error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  };

  if (state === "saved") {
    return (
      <div className="page-offer saved">
        ✓ '{name}' 링크를 기억했습니다.{evicted ? ` 저장 링크가 가득 차 가장 오래 쓰지 않은 '${evicted}'을(를) 지웠습니다.` : ""}
      </div>
    );
  }
  if (!open) {
    return (
      <div className="page-offer">
        <button type="button" className="ghost-btn" onClick={() => void openCard()}>
          이 페이지 기억하기
        </button>
      </div>
    );
  }
  return (
    <div className="page-offer open">
      {drafting && <span className="field-help">요청과 페이지 내용으로 이름·용도·주소 값을 채우는 중…</span>}
      <label className="field">
        <span className="field-label">이름</span>
        <input
          value={name}
          maxLength={80}
          onChange={(e) => {
            touched.current.name = true;
            setName(e.target.value);
          }}
        />
      </label>
      <label className="field">
        <span className="field-label">용도</span>
        <input
          value={purpose}
          maxLength={MAX_PURPOSE}
          placeholder="예: 쇼핑을 위한 가격 비교 검색"
          onChange={(e) => {
            touched.current.purpose = true;
            setPurpose(e.target.value);
          }}
        />
      </label>
      {offer.params.length > 0 && (
        <div className="field">
          <span className="field-label">주소의 값</span>
          <ul className="offer-params">
            {offer.params.map((p, i) => (
              <li key={`${p.key}-${i}`}>
                <span className="offer-param-key">{p.key}</span>
                <span className="offer-param-value">{p.value}</span>
                <select
                  value={modes[i]}
                  onChange={(e) => {
                    touched.current.params = true;
                    setModes((cur) => cur.map((m, j) => (j === i ? (e.target.value as Mode) : m)));
                  }}
                >
                  <option value="keep">고정</option>
                  <option value="slot">입력 자리</option>
                  <option value="drop">빼기</option>
                </select>
                {modes[i] === "slot" && (
                  <input
                    className="offer-slot-name"
                    value={slots[i]}
                    maxLength={MAX_SLOT_KEY}
                    placeholder="자리 이름(예: 상품명)"
                    onChange={(e) => {
                      touched.current.params = true;
                      setSlots((cur) => cur.map((s, j) => (j === i ? e.target.value : s)));
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {slotNames.map((k) => (
        <label key={k} className="field">
          <span className="field-label">'{k}' 자리 설명(선택)</span>
          <input
            value={hints[k] ?? ""}
            maxLength={100}
            placeholder="예: 검색할 상품 이름"
            onChange={(e) => {
              touched.current.hints.add(k);
              setHints((cur) => ({ ...cur, [k]: e.target.value }));
            }}
          />
        </label>
      ))}
      <div className="page-offer-url">{previewError || preview}</div>
      {offer.warning && (
        <label className="check-row page-offer-warn">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>⚠ 이 주소에 {offer.warning} 단서가 있어 보입니다. 그 값을 고정으로 남겨도 저장합니다.</span>
        </label>
      )}
      {offer.evicts && !previewError && !offer.savedTemplates.includes(preview) && (
        <span className="field-help">저장 링크가 가득 찼습니다. 저장하면 가장 오래 쓰지 않은 '{offer.evicts}'이(가) 지워집니다.</span>
      )}
      <span className="field-help">
        카드를 열면 이번 요청·답·페이지 글자를 모델(OpenRouter)에 보내 이름·용도·주소 값 초안을 채웁니다. 입력 자리의 지금 값은
        저장하지 않습니다. 저장한 이름·용도·자리 이름·사이트는 사이트와 관계없이 모델(OpenRouter)에 후보로
        전송되고, 요청이 용도에 맞으면 도우미가 자리에 값을 넣어 엽니다. 설정에서 고치거나 지울 수 있습니다.
      </span>
      {state === "error" && <span className="field-help error-text">{error}</span>}
      <div className="page-offer-actions">
        <button type="button" className="btn-cancel" onClick={close}>
          취소
        </button>
        <button
          type="button"
          className="btn-approve"
          disabled={state === "saving" || drafting || !name.trim() || !!previewError}
          onClick={save}
        >
          저장
        </button>
      </div>
    </div>
  );
}
