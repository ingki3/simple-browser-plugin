// 모의 모델의 요청 분류(#284 계획 11절 P2-7·12절 P2). 제공자 실제 요청 구조에서 system 글과 마지막 user 글을 뽑는다.
// 경로는 둘뿐이다: OpenAI 호환(OpenRouter·OpenAI·Gemini·로컬 — messages의 role=system)과 Anthropic(최상위 system + messages).
// 단위 시험(tests/requestParts.test.mjs)과 하네스(lib.mjs가 이 함수들의 소스를 서비스 워커에 넣는다)가 함께 쓴다. 그래서
// 함수는 바깥 이름에 기대지 않게(표지 문구도 안에) 쓴다.

export function requestParts(body) {
  const textOf = (c) => {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
    return "";
  };
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const system = body && "system" in body ? textOf(body.system) : msgs.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n\n");
  const users = msgs.filter((m) => m.role === "user");
  const user = users.length ? textOf(users[users.length - 1].content) : "";
  return { system, user };
}

// 반복 작업 요청의 종류: "plan"(작전 만들기) / "region"(작전 영역 판단) / "full"(전체 화면 판단) / null(그 밖).
// 표지는 src/lib/repeatPlan.ts의 PLAN_SYSTEM_MARK·REGION_SYSTEM_MARK와 src/lib/repeatTask.ts REPEAT_CHECK_SYSTEM의 첫 줄이다.
export function repeatRequestKind(body) {
  const textOf = (c) => {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
    return "";
  };
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const system = body && "system" in body ? textOf(body.system) : msgs.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n\n");
  if (system.includes("반복 확인 작전을 만든다")) return "plan";
  if (system.includes("반복 확인 작전의 영역만 보고")) return "region";
  if (system.includes("너는 웹 페이지가 사용자가 정한 조건을 만족하는지 판단한다")) return "full";
  return null;
}
