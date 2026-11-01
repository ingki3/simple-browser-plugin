import { useEffect, useState } from "react";
import type { LoginSiteOp } from "@/lib/settingsOps";
import { useLatestGate, useStorageKeys } from "../hooks/syncHelpers";
import { hostManifest, KEEPASSXC_HOST } from "@/lib/keepassxc";
import type { LoginSite } from "@/lib/loginPolicy";
import { FieldHelp } from "./FieldHelp";

interface Props {
  // 저장된 목록(useSettings가 따라감). 빼기·코드 변경은 항목 하나씩, 보던 승인의 grantId와 함께 보낸다(#127).
  sites: LoginSite[];
}

type Status =
  | { state: "no_permission" }
  | { state: "not_connected" }
  | { state: "connected"; id: string }
  | { state: "error"; message: string; id?: string };

// 운영체제별 keepassxc-proxy 위치와 호스트 manifest를 둘 곳(Chrome 기준).
function platformGuide(): { proxy: string; dir: string; note?: string } {
  const p = navigator.userAgent;
  if (/Mac/i.test(p)) {
    return {
      proxy: "/Applications/KeePassXC.app/Contents/MacOS/keepassxc-proxy",
      dir: "~/Library/Application Support/Google/Chrome/NativeMessagingHosts/",
    };
  }
  if (/Win/i.test(p)) {
    return {
      proxy: "C:\\Program Files\\KeePassXC\\keepassxc-proxy.exe",
      dir: "아무 폴더(예: %LOCALAPPDATA%\\SimpleBrowserHelper\\)",
      note: `레지스트리 HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\${KEEPASSXC_HOST}의 기본값에 manifest 파일 경로를 넣습니다.`,
    };
  }
  return { proxy: "/usr/bin/keepassxc-proxy", dir: "~/.config/google-chrome/NativeMessagingHosts/" };
}

async function ask(kind: "keepassxc_status" | "keepassxc_associate" | "keepassxc_forget"): Promise<Status> {
  const res = (await chrome.runtime.sendMessage({ kind })) as { ok?: boolean; data?: Status; error?: string } | undefined;
  if (!res?.ok || !res.data) throw new Error(res?.error ?? "KeePassXC 상태를 읽지 못했습니다.");
  return res.data;
}

// 자동 로그인(docs/design/login-automation.md): KeePassXC 연결과 자동 로그인을 승인한 사이트(출처 → 항목) 목록.
// 사이트는 sign_in 승인 카드의 "앞으로 자동 로그인"으로만 더한다(항목을 그 자리에서 고르므로). 여기서는 빼기와 일회용 코드 켜기만.
export function LoginSitesField({ sites }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [siteBusy, setSiteBusy] = useState(false);
  const sendOp = async (op: LoginSiteOp) => {
    setSiteBusy(true);
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage({ kind: "login_site_op", op })) as { ok?: boolean; error?: string } | undefined;
      if (!res?.ok) throw new Error(res?.error ?? "응답이 없습니다.");
    } catch (err) {
      setError(`자동 로그인 목록을 바꾸지 못했습니다(${err instanceof Error ? err.message : String(err)}).`);
    } finally {
      setSiteBusy(false);
    }
  };
  const guide = platformGuide();
  const manifest = hostManifest(chrome.runtime.id, guide.proxy);

  // 마지막 요청의 응답만 화면에 쓴다(#127).
  const gate = useLatestGate();
  const run = async (label: string, fn: () => Promise<Status>) => {
    const latest = gate();
    setBusy(label);
    setError(null);
    try {
      const next = await fn();
      if (latest()) setStatus(next);
    } catch (err) {
      if (latest() || label !== "status") setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((b) => (b === label ? null : b));
    }
  };

  useEffect(() => {
    void run("status", () => ask("keepassxc_status"));
    // 다른 화면에서 연결·잊기를 하거나 선택 권한이 바뀌면 다시 읽는다(설정 탭을 오래 열어 두어도).
    const onPerm = () => void run("status", () => ask("keepassxc_status"));
    // (이 버전의 타입 정의에는 removeListener가 빠져 있어 일반 이벤트로 본다.)
    const events = [chrome.permissions.onAdded, chrome.permissions.onRemoved] as unknown as chrome.events.Event<() => void>[];
    for (const e of events) e.addListener(onPerm);
    return () => {
      for (const e of events) e.removeListener(onPerm);
    };
  }, []);
  useStorageKeys(["keepassxcAssociation"], () => void run("status", () => ask("keepassxc_status")));

  const grant = () =>
    run("grant", async () => {
      const ok = await chrome.permissions.request({ permissions: ["nativeMessaging"] });
      if (!ok) throw new Error("권한을 허용하지 않았습니다.");
      return ask("keepassxc_status");
    });

  return (
    <div className="field">
      <span className="field-label">비밀번호 관리자(KeePassXC)</span>
      <div className="google-status-row">
        {status?.state === "connected" ? (
          <span className="tag-ok">● 연결됨({status.id})</span>
        ) : status?.state === "error" ? (
          <span className="tag-warn">● 확인 필요</span>
        ) : status?.state === "not_connected" ? (
          <span className="tag-warn">● 연결 전</span>
        ) : (
          <span className="tag-off">● 꺼짐</span>
        )}
        {status?.state === "no_permission" && (
          <button type="button" className="ghost-btn" disabled={busy !== null} onClick={() => void grant()}>
            {busy === "grant" ? "요청 중…" : "켜기(권한 허용)"}
          </button>
        )}
        {status && status.state !== "no_permission" && status.state !== "connected" && (
          <button type="button" className="ghost-btn" disabled={busy !== null} onClick={() => void run("assoc", () => ask("keepassxc_associate"))}>
            {busy === "assoc" ? "KeePassXC 창에서 승인하세요…" : "KeePassXC와 연결"}
          </button>
        )}
        {status && (status.state === "connected" || (status.state === "error" && status.id)) && (
          <button type="button" className="ghost-btn" disabled={busy !== null} onClick={() => void run("forget", () => ask("keepassxc_forget"))}>
            연결 해제
          </button>
        )}
        <button type="button" className="ghost-btn" disabled={busy !== null} onClick={() => void run("status", () => ask("keepassxc_status"))}>
          다시 확인
        </button>
      </div>
      {status?.state === "error" && <span className="field-error">{status.message}</span>}
      {error && <span className="field-error">{error}</span>}
      {status && status.state !== "connected" && (
        <div className="setup-card">
          <strong>처음 한 번 설정</strong>
          <ol>
            <li>KeePassXC 설정 → 브라우저 통합에서 "브라우저 통합 사용"을 켭니다.</li>
            <li>
              아래 내용을 <code>{KEEPASSXC_HOST}.json</code> 파일로 <code>{guide.dir}</code>에 저장합니다(keepassxc-proxy 경로가
              다르면 고칩니다).
              {guide.note && <> {guide.note}</>}
            </li>
            <li>위의 "켜기"로 권한을 허용하고 "KeePassXC와 연결"을 누른 뒤 KeePassXC 창에서 연결을 승인합니다.</li>
          </ol>
          <pre className="tool-card-details">{manifest}</pre>
        </div>
      )}

      <span className="field-label">자동 로그인 사이트</span>
      {sites.length === 0 ? (
        <span className="field-hint">아직 없습니다. 로그인 카드에서 "로그인 + 이 사이트는 앞으로 자동 로그인"을 고르면 더해집니다.</span>
      ) : (
        <ul className="site-list">
          {sites.map((s) => (
            <li key={s.origin} className="key-row">
              <span className="site-name" title={s.uuid}>
                {s.origin} · {s.entryName || "(이름 없음)"}
              </span>
              <label className="check-row" title="2단계 인증의 일회용 코드(TOTP)도 KeePassXC에서 받아 넣습니다.">
                <input
                  type="checkbox"
                  checked={s.totp}
                  disabled={!s.grantId || siteBusy}
                  onChange={(e) => void sendOp({ op: "set_totp", origin: s.origin, grantId: s.grantId, totp: e.target.checked })}
                />
                <span>코드</span>
              </label>
              <button
                type="button"
                className="ghost-btn"
                disabled={!s.grantId || siteBusy}
                title={s.grantId ? undefined : "준비 중입니다. 잠시 뒤 다시 누르세요."}
                onClick={() => void sendOp({ op: "remove", origin: s.origin, grantId: s.grantId })}
              >
                빼기
              </button>
            </li>
          ))}
        </ul>
      )}
      <FieldHelp summary="여기 있는 사이트(정확한 주소)에서는 묻지 않고 고른 항목으로 로그인합니다. 값은 모델에 보내지 않습니다.">
        로그인 화면에서 도우미가 KeePassXC의 아이디·비밀번호를 직접 넣고 제출합니다. 값은 모델로 보내지 않고, 페이지가 넣은 값을 화면에
        다시 보여 주면 그 부분을 가립니다. 다만 페이지 자체는 넣은 값을 읽을 수 있으니 믿는 사이트만 더하세요. 새 비밀번호 칸이 있는
        화면(가입·비밀번호 변경), 다른 주소로 보내는 양식, 삭제·결제 신호가 있는 양식, 한 대화에서 이미 시도한 사이트는 자동으로 하지
        않고 묻습니다. "코드"를 켜면 2단계 인증 코드도 넣습니다(비밀번호와 코드를 함께 맡기므로 2단계 인증의 효과가 줄어듭니다).
      </FieldHelp>
    </div>
  );
}
