import { useEffect, useRef, useState } from "react";
import { makeTemplate, MAX_PURPOSE, MAX_SLOT_KEY, normalizeSlotKey, templateText, type ParamChoice } from "@/lib/savedPages";
import type { ChatMessage } from "../state/chatStore";
import { useSettings } from "../hooks/useSettings";

type Props = Extract<ChatMessage, { type: "page_offer" }>;

interface Draft {
  name: string;
  purpose: string;
  choices: ParamChoice[];
  hints: Record<string, string>;
  optional: string[];
  overflow: string[];
}

type Mode = ParamChoice["mode"];

// "이 페이지 기억하기"(#30·#86): 이름·용도를 확인하고, 쿼리 값마다 고정·입력 자리·빼기를 골라 다시 쓸 수 있는 링크로 저장한다.
// 카드를 열면 모델에 초안(이름·용도·값마다 고정·자리·빼기·비워도 되는 자리)을 한 번 자동으로 묻고(이 턴의 요청·답·페이지
// 글자를 함께 보낸다 — 사용자 결정으로 #129의 "누를 때만"을 바꿈), 사용자가 고쳐 저장한다. 주소에 결제·개인정보 단서가 보이면
// 초안을 묻지 않고, 저장할 때 한 번 더 확인한다. 페이지 기억하기가 꺼져 있으면 묻지도 저장하지도 않는다.
export function PageOfferCard({ offer, startOpen, autoDraft = true, initialDraft }: Props) {
  const [open, setOpen] = useState(!!startOpen);
  // 방문 기록 추천(#175) 카드는 추천을 초기값으로 쓰고 초안을 묻지 않는다.
  const init = initialDraft && initialDraft.choices.length === offer.params.length ? initialDraft : null;
  const [name, setName] = useState(initialDraft?.name || offer.title);
  const [purpose, setPurpose] = useState(initialDraft?.purpose ?? "");
  const [modes, setModes] = useState<Mode[]>(() => (init ? init.choices.map((c) => c.mode) : offer.params.map(() => "keep")));
  const [slots, setSlots] = useState<string[]>(() => (init ? init.choices.map((c) => (c.mode === "slot" ? c.slot : "")) : offer.params.map(() => "")));
  const [hints, setHints] = useState<Record<string, string>>(() => ({ ...(init?.hints ?? {}) }));
  // 비워도 되는 자리 이름(사용자가 체크박스로 고름, 초안이 제안).
  const [optional, setOptional] = useState<Set<string>>(() => new Set(init?.optional ?? []));
  const [overflow, setOverflow] = useState<string[]>(() => init?.overflow ?? []);
  const [drafting, setDrafting] = useState(false);
  const [draftFailed, setDraftFailed] = useState(false);
  const { settings, loaded } = useSettings();
  const enabled = !loaded || settings.rememberPages;
  const [confirmed, setConfirmed] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [evicted, setEvicted] = useState<string | null>(null);
  // 저장할 때 지워질 링크가 카드를 띄울 때와 달라졌으면 백그라운드가 알려 준 새 예고. 그때의 템플릿(preview)에만 쓰고,
  // 템플릿을 고치면 카드를 띄울 때의 예고로 돌아간다(백그라운드가 저장할 때 다시 확인한다).
  const [evictOverride, setEvictOverride] = useState<{ preview: string; value: { id: string; name: string } | null } | null>(null);
  // 초안을 기다리는 사이 사용자가 고친 칸은 늦게 온 초안으로 덮지 않는다. 카드를 닫았다 다시 열면 이전 요청의 응답은 버린다.
  const touched = useRef({ name: false, purpose: false, params: false, hints: new Set<string>(), optional: false });
  const draftSeq = useRef(0);
  // 자동 초안은 카드마다 한 번만(닫았다 다시 열어도 다시 묻지 않는다 — 진행 중이면 그 응답을 그대로 반영).
  const autoTried = useRef(false);

  const choices: ParamChoice[] = modes.map((m, i) => (m === "slot" ? { mode: "slot", slot: slots[i] } : { mode: m }));
  let preview = "";
  let previewError = "";
  try {
    preview = templateText(makeTemplate(offer.url, choices).template);
  } catch (err) {
    previewError = err instanceof Error ? err.message : String(err);
  }
  // 자리 이름은 저장(makeTemplate)과 같은 정규화로 묶는다(연속 공백 등이 달라도 한 자리 — 설명·비워도 됨을 함께 쓴다).
  const slotNames = [
    ...new Set(
      modes.flatMap((m, i) => {
        const k = m === "slot" ? normalizeSlotKey(slots[i]) : null;
        return k ? [k] : [];
      }),
    ),
  ];

  // 사용자에게 보여 준(저장하면 지워질) 링크. 같은 템플릿을 다시 저장하면 지우지 않는다.
  const shownEvict =
    evictOverride && evictOverride.preview === preview
      ? evictOverride.value
      : offer.evicts && !previewError && !offer.savedTemplates.includes(preview)
        ? offer.evicts
        : null;

  const requestDraft = async () => {
    // 결제·개인정보 단서가 보이는 주소는 초안을 묻지 않는다(경로·제목·본문으로도 값이 샐 수 있어 사용자가 직접 정한다).
    // 페이지 기억하기가 꺼져 있으면 묻지 않는다(백그라운드도 다시 확인한다).
    if (offer.warning || !enabled) return;
    const seq = ++draftSeq.current;
    setDrafting(true);
    setDraftFailed(false);
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
        if (!t.optional) setOptional(new Set(d.optional ?? []));
        setOverflow(d.overflow ?? []);
      } else if (seq === draftSeq.current) {
        setDraftFailed(true);
      }
    } catch {
      // 초안 없이 직접 정한다.
      if (seq === draftSeq.current) setDraftFailed(true);
    } finally {
      if (seq === draftSeq.current) setDrafting(false);
    }
  };
  // 닫아도 진행 중인 초안은 버리지 않는다(다시 열면 반영돼 있다).
  const close = () => setOpen(false);
  useEffect(() => {
    // autoDraft가 false면(외부 본문 보호 중 remember_page) 자동으로 묻지 않는다 — "다시 채우기"를 누를 때만.
    if (!open || !autoDraft || initialDraft || autoTried.current || offer.warning || !loaded || !settings.rememberPages) return;
    autoTried.current = true;
    void requestDraft();
  }, [open, loaded, settings.rememberPages]);

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
        optional: slotNames.filter((k) => optional.has(k)),
        confirmedWarning: confirmed,
        expectEvictId: shownEvict?.id ?? null,
      })) as
        | { ok: boolean; data?: { evicted: string | null } | { evictChanged: { id: string; name: string } | null }; error?: string }
        | undefined;
      if (res?.ok && res.data && "evictChanged" in res.data) {
        // 다른 카드를 먼저 저장해 지워질 링크가 바뀌었다. 새 예고를 보이고 다시 누르게 한다(저장하지 않았다).
        setEvictOverride({ preview, value: res.data.evictChanged });
        setError(
          res.data.evictChanged
            ? `지워질 링크가 '${res.data.evictChanged.name}'(으)로 바뀌었습니다. 확인한 뒤 다시 저장을 누르세요.`
            : "이제 저장해도 지워지는 링크가 없습니다. 다시 저장을 누르세요.",
        );
        setState("error");
      } else if (res?.ok) {
        setEvicted(res.data && "evicted" in res.data ? res.data.evicted : null);
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
        <button type="button" className="ghost-btn" onClick={() => setOpen(true)}>
          이 페이지 기억하기
        </button>
      </div>
    );
  }
  return (
    <div className="page-offer open">
      {!enabled && <span className="field-help error-text">페이지 기억하기가 꺼져 있어 저장할 수 없습니다(설정 → 페이지 기억하기).</span>}
      {initialDraft && (
        <span className="field-help page-offer-history">
          방문 기록 추천으로 채웠습니다(쿼리 값은 보내지 않았습니다). 확인하고 고친 뒤 저장하세요.
        </span>
      )}
      {!initialDraft && !offer.warning && enabled && (
        <div className="page-offer-draft">
          <button type="button" className="ghost-btn" disabled={drafting} onClick={() => void requestDraft()}>
            {drafting ? "채우는 중…" : "다시 채우기"}
          </button>
          <span className="field-help">
            {autoDraft
              ? "카드를 열면 이번 요청·답·페이지 글자를 설정에서 고른 모델 제공자에 보내 이름·용도·자리를 일반적인 형태로 채웁니다. 직접 고쳐도 됩니다."
              : "외부 문서 내용을 읽은 대화라 자동으로 채우지 않았습니다. 누르면 이번 요청·답·페이지 글자를 모델 제공자에 보내 채웁니다. 직접 적어도 됩니다."}
          </span>
          {draftFailed && <span className="field-help error-text">초안을 받지 못했습니다. 직접 적거나 다시 채우기를 누르세요.</span>}
        </div>
      )}
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
        <div key={k} className="field">
          <label className="field">
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
          <label className="check-row">
            <input
              type="checkbox"
              checked={optional.has(k)}
              onChange={(e) => {
                touched.current.optional = true;
                setOptional((cur) => {
                  const next = new Set(cur);
                  if (e.target.checked) next.add(k);
                  else next.delete(k);
                  return next;
                });
              }}
            />
            <span>비워도 됨(값이 없으면 이 조건 없이 엽니다)</span>
          </label>
        </div>
      ))}
      {overflow.length > 0 && (
        <span className="field-help">
          입력 자리가 10개를 넘어 다음 값은 고정으로 두었습니다: {overflow.join(", ")}. 그 값이 다음에도 그대로 쓰이니 필요하면 빼기로 바꾸세요.
        </span>
      )}
      <div className="page-offer-url">{previewError || preview}</div>
      {offer.warning && (
        <label className="check-row page-offer-warn">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>⚠ 이 주소에 {offer.warning} 단서가 있어 보입니다. 그 값을 고정으로 남겨도 저장합니다.</span>
        </label>
      )}
      {shownEvict && (
        <span className="field-help">저장 링크가 가득 찼습니다. 저장하면 가장 오래 쓰지 않은 '{shownEvict.name}'이(가) 지워집니다.</span>
      )}
      <span className="field-help">
        입력 자리의 지금 값은 저장하지 않습니다. 저장한 이름·용도·자리 이름·사이트는 사이트와 관계없이 고른 모델 제공자에 후보로
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
          disabled={state === "saving" || drafting || !enabled || !name.trim() || !!previewError}
          onClick={save}
        >
          저장
        </button>
      </div>
    </div>
  );
}
