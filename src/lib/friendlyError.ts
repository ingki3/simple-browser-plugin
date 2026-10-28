// 오류를 사용자가 알아들을 말과 다음 행동으로 바꾼다(#130). 원인은 오류의 구조(HTTP 상태 코드·오류 종류)로만 정하고,
// 제공자가 보낸 문구는 '자세히'에 그대로 둔다. npm test(Node 타입 제거 실행)로 시험하므로 다른 모듈을 불러오지 않는다.

// 다음 행동: 설정 열기(키·모델), 사용량 확인(제공자 사이트).
export type ErrorAction = "settings" | "usage";

export interface FriendlyError {
  message: string;
  // 원래 오류 문구(바꾼 경우만).
  detail?: string;
  action?: ErrorAction;
}

// 저장한 API 키가 없을 때.
export class MissingKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingKeyError";
  }
}

function httpStatus(err: unknown): number | null {
  if (!(err instanceof Error) || err.name !== "ProviderHttpError") return null;
  const status = (err as Error & { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

export function friendlyError(err: unknown): FriendlyError {
  const raw = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.name === "MissingKeyError") {
    return { message: "API 키가 없습니다. 설정에서 모델 제공자의 API 키를 넣어 주세요.", action: "settings" };
  }
  const status = httpStatus(err);
  if (status !== null) {
    const mapped = byStatus(status);
    if (mapped) return { ...mapped, detail: raw };
  }
  // fetch가 서버에 닿지 못하면 TypeError를 던진다(네트워크 끊김·주소 차단).
  if (err instanceof TypeError) {
    return { message: "모델 제공자에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.", detail: raw };
  }
  return { message: raw };
}

function byStatus(status: number): Omit<FriendlyError, "detail"> | null {
  if (status === 401 || status === 403) {
    return { message: "API 키가 맞지 않거나 이 모델을 쓸 권한이 없습니다. 설정에서 키를 확인해 주세요.", action: "settings" };
  }
  if (status === 402) {
    return { message: "API 잔액이 부족합니다. 키를 받은 곳에서 충전하거나 사용 한도를 확인해 주세요.", action: "usage" };
  }
  if (status === 429) {
    return {
      message: "요청이 너무 많거나 사용 한도에 닿았습니다. 잠시 뒤 다시 시도하거나 사용량을 확인해 주세요.",
      action: "usage",
    };
  }
  if (status === 404) {
    return { message: "모델을 찾지 못했습니다. 설정에서 모델 이름을 확인해 주세요.", action: "settings" };
  }
  if (status === 400 || status === 422) {
    return {
      message: "모델 제공자가 요청을 받지 않았습니다. 고른 모델이 도구 호출을 지원하는지 확인하거나 다른 모델을 골라 보세요.",
      action: "settings",
    };
  }
  if (status >= 500) {
    return { message: "모델 제공자 쪽에 일시적인 문제가 있습니다. 잠시 뒤 다시 시도해 주세요." };
  }
  return null;
}
