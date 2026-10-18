// 조작 대상 주변의 맥락 판정(결제 화면인지 등). 클릭 대상과 입력 칸이 함께 쓴다.
import { PAYMENT_TEXT_RE, decodeDeepText, splitIdentifier } from "@/lib/autoApprove";
import { isShadowRoot } from "./docs";

function parentDocument(doc: Document): Document | null {
  const win = doc.defaultView;
  if (!win || win === win.parent) return null;
  try {
    return win.parent.document;
  } catch {
    return null;
  }
}

function paymentDocument(doc: Document): boolean {
  const loc = doc.defaultView?.location;
  // 경로·쿼리·해시를 따로, 잘못된 인코딩이 섞여도 올바른 부분은 풀어 본다.
  const route = [loc?.pathname ?? "", loc?.search ?? "", loc?.hash ?? ""].map(decodeDeepText).join("");
  const words = splitIdentifier(route);
  // order·pay는 낱말 단위로만(border-collie, display 같은 단어 속 글자는 아님).
  if (/(checkout|payment)/i.test(route) || /(\bpay\b|\border\b)/i.test(words)) return true;
  // 컴포넌트의 열린 shadow root 안 제목(<checkout-title>의 <h1>결제 금액</h1>)도 본다.
  const roots: Array<Document | Element | ShadowRoot> = [doc];
  if (doc.documentElement) {
    const scan = nestedContainerScan(doc.documentElement);
    // 한도에 걸려 끝까지 보지 못했으면 결제 제목이 숨어 있을 수 있으니 결제 화면으로 본다(묻기).
    if (scan.incomplete) return true;
    roots.push(...scan.containers.filter((n) => isShadowRoot(n)));
  }
  const headings = roots
    .flatMap((r) => Array.from(r.querySelectorAll("h1, h2"), (h) => h.textContent ?? ""))
    .join(" ");
  return PAYMENT_TEXT_RE.test(`${route} ${doc.title} ${headings}`);
}

// 자신부터 위로 올라가며 selector에 맞는 첫 요소. shadow root 경계를 넘어 host로 올라간다.
export function closestAcross(el: Element, selector: string): Element | null {
  for (let cur: Element | null = el; cur; cur = eventParent(cur)) {
    if (cur.matches(selector)) return cur;
  }
  return null;
}

// 자신부터 위로 올라가며 selector에 맞는 모든 조상(가까운 것부터). 겹친 대화상자를 모두 보려고.
export function allAcross(el: Element, selector: string): Element[] {
  const out: Element[] = [];
  for (let cur: Element | null = el; cur; cur = eventParent(cur)) if (cur.matches(selector)) out.push(cur);
  return out;
}

// 클릭 이벤트가 거쳐 가는 경로의 다음 요소: slot에 배치된 요소는 그 slot(그 위 shadow 트리의 링크가 작동한다),
// 아니면 부모, shadow root의 맨 위면 host.
export function eventParent(el: Element): Element | null {
  const slot = (el as HTMLElement).assignedSlot;
  if (slot) return slot;
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return isShadowRoot(root) ? root.host : null;
}

// 결제 화면인지: 문서 주소(경로·쿼리·해시 — SPA는 #/checkout·?route=checkout처럼 라우팅한다)·제목·큰 제목(h1·h2),
// 또는 대상이 든 양식·대화상자의 글자(앞부분)에 결제 단서가 있으면.
// section·article은 보지 않는다(상품 목록 구역에 "구매 1,234" 같은 글자가 흔해 목록 안 버튼이 모두 걸린다).
export function inPaymentContext(el: HTMLElement, form: HTMLFormElement | null): boolean {
  // 같은 출처 iframe 안의 버튼은 바깥 문서(부모 프레임들)의 주소·제목·큰 제목도 본다.
  for (let doc: Document | null = el.ownerDocument; doc; doc = parentDocument(doc)) {
    if (paymentDocument(doc)) return true;
  }
  // 클릭 이벤트 경로에 있는 shadow root들(웹 컴포넌트가 그린 결제 화면, slot에 배치된 버튼 포함)의 큰 제목도 본다.
  const seen = new Set<Node>();
  for (let cur: Element | null = el; cur; cur = eventParent(cur)) {
    const root = cur.getRootNode();
    if (!isShadowRoot(root) || seen.has(root)) continue;
    seen.add(root);
    const headings = Array.from(root.querySelectorAll("h1, h2"), (h) => h.textContent ?? "").join(" ");
    if (PAYMENT_TEXT_RE.test(headings)) return true;
  }
  // 양식과 그 바깥 대화상자를 각각 본다(대화상자의 "결제 금액" 문구 아래 양식 속 '확인' 버튼).
  // 대상의 대화상자와, 연결된 양식이 든 대화상자(<button form=f>가 대화상자 밖에 있는 경우)를 모두 본다.
  const dialogSel = 'dialog, [role="dialog"], [role="alertdialog"]';
  // 겹친 대화상자는 바깥쪽까지 모두 본다(바깥 대화상자의 결제 금액, 안쪽 대화상자의 '확인').
  const dialogs = [...allAcross(el, dialogSel), ...(form ? allAcross(form, dialogSel) : [])];
  if ([form, ...dialogs].some((scope) => !!scope && PAYMENT_TEXT_RE.test(deepText(scope)))) {
    return true;
  }
  // 같은 출처 iframe 안이면 그 iframe 요소를 부모 문서의 대상으로 보고 대화상자·shadow 맥락을 다시 본다
  // (결제 대화상자 안에 iframe이 있고 그 안의 '확인' 버튼).
  const frame = frameElementOf(el.ownerDocument);
  // 부모 쪽에서는 iframe을 감싼 양식도 함께 본다(바깥 양식의 결제 문구, iframe 버튼이 부모 양식을 제출).
  return !!frame && inPaymentContext(frame as HTMLElement, closestAcross(frame, "form") as HTMLFormElement | null);
}

function frameElementOf(doc: Document): Element | null {
  try {
    return doc.defaultView?.frameElement ?? null;
  } catch {
    return null;
  }
}

// 링크 요소의 실제 목적지 문자열. SVG <a>의 href는 문자열이 아니라 SVGAnimatedString이라 속성에서 읽어
// 문서 주소 기준으로 푼다. 풀 수 없으면 속성 값 그대로(웹 주소가 아니면 사이트 판정에서 묻는다).
export function linkHrefOf(el: Element): string {
  if (el.localName !== "a" && el.localName !== "area") return "";
  const raw = el.getAttribute("href") ?? el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
  if (raw === null) return "";
  try {
    return new URL(raw, el.baseURI).href;
  } catch {
    return raw;
  }
}

// 양식 없는 화면에서 대상의 처리기가 읽어 보낼 수 있는 입력 칸 범위들: 감싼 대화상자가 있으면 그것 하나,
// 없으면 클릭 경로에 있는 shadow root들과 문서 body 전체(가까운 일반 칸에서 멈추면 바깥의 이메일·비밀번호 칸을
// 놓친다). 범위 안에서는 어느 양식에도 속하지 않은 칸만 본다(personalValuedElements).
export interface FormlessScope {
  node: Element | ShadowRoot;
  // 대화상자 안이면 안쪽 양식에 속한 칸도 본다(바깥 버튼이 안쪽 양식을 requestSubmit하는 경우).
  includeFormFields: boolean;
  // 하위 컨테이너 탐색이 한도에 걸려 끝까지 보지 못했는지(그러면 개인정보가 있는 것으로 본다).
  incomplete?: boolean;
}

export function formlessScopes(el: Element): FormlessScope[] {
  // 겹친 대화상자면 가장 바깥 것을 범위로 삼는다(안쪽 버튼이 바깥 대화상자의 칸을 제출할 수 있다).
  const dialogChain = allAcross(el, 'dialog, [role="dialog"], [role="alertdialog"]');
  const dialog = dialogChain.length ? dialogChain[dialogChain.length - 1] : null;
  const inDialog = !!dialog;
  const nodes: Array<Element | ShadowRoot> = [];
  let incomplete = false;
  // 클릭 경로의 shadow root들(대화상자가 있으면 그 안쪽 것만).
  for (let cur: Element | null = el; cur && cur !== dialog; cur = eventParent(cur)) {
    const root = cur.getRootNode();
    if (isShadowRoot(root) && !nodes.includes(root)) nodes.push(root);
  }
  const base = dialog ?? el.ownerDocument.body;
  if (base) {
    nodes.push(base);
    // 범위 안 다른 웹 컴포넌트의 열린 shadow root와 같은 출처 iframe 문서도 서로 교차해 본다
    // (querySelectorAll은 shadow·iframe 안으로 들어가지 않는다).
    const scan = nestedContainerScan(base);
    for (const n of scan.containers) if (!nodes.includes(n)) nodes.push(n);
    if (scan.incomplete) incomplete = true;
  }
  const scopes: FormlessScope[] = nodes.map((node) => ({ node, includeFormFields: inDialog, incomplete }));
  // 같은 출처 iframe 안의 대상이면 iframe 요소를 부모 문서의 대상으로 보고 부모 쪽 범위도 더한다
  // (부모 대화상자의 이메일·비밀번호를 iframe 안 버튼이 부모 함수로 제출).
  const frame = frameElementOf(el.ownerDocument);
  if (frame) for (const s of formlessScopes(frame)) if (!scopes.some((x) => x.node === s.node)) scopes.push(s);
  return scopes;
}

// 범위 안의 하위 컨테이너들: 열린 shadow root와 같은 출처 iframe 문서 body를 서로 교차해 따라 들어간다
// (iframe 안 컴포넌트의 shadow root, shadow root 안 iframe). 전체 최대 220개.
export function nestedContainersIn(scope: Element | ShadowRoot): Array<Element | ShadowRoot> {
  return nestedContainerScan(scope).containers;
}

// 하위 컨테이너와, 한도(220개)에 걸려 끝까지 보지 못했는지.
export function nestedContainerScan(scope: Element | ShadowRoot): { containers: Array<Element | ShadowRoot>; incomplete: boolean } {
  const out: Array<Element | ShadowRoot> = [];
  const queue: Array<Element | ShadowRoot> = [scope];
  // 범위 요소 자신의 열린 shadow root도 넣는다(커스텀 요소 버튼이 자기 shadow에 글자를 그리는 경우).
  const own = !isShadowRoot(scope) ? (scope as HTMLElement).shadowRoot : null;
  if (own) {
    out.push(own);
    queue.push(own);
  }
  while (queue.length && out.length < 220) {
    const node = queue.shift()!;
    for (const child of Array.from(node.querySelectorAll("*"))) {
      let next: Element | ShadowRoot | null = (child as HTMLElement).shadowRoot ?? null;
      if (!next && (child.localName === "iframe" || child.localName === "frame")) {
        try {
          next = (child as HTMLIFrameElement).contentDocument?.body ?? null;
        } catch {
          next = null;
        }
      }
      if (next && !out.includes(next)) {
        out.push(next);
        queue.push(next);
        if (out.length >= 220) break;
      }
    }
  }
  return { containers: out, incomplete: out.length >= 220 };
}

// 범위 안의 열린 shadow root들(iframe 안 것 포함).
export function openShadowRootsIn(scope: Element | ShadowRoot): ShadowRoot[] {
  return nestedContainersIn(scope).filter((n): n is ShadowRoot => isShadowRoot(n));
}

// 칸의 지금 값 요약(승인 당시와 같은지 비교용). 체크·선택·파일은 상태로, 읽을 수 없는 커스텀 컨트롤은 빈 값.
export function fieldValueSignature(el: Element): string {
  const f = el as HTMLInputElement;
  if (el.localName === "select") {
    return Array.from((el as HTMLSelectElement).selectedOptions, (o) => o.value).join("\u0001");
  }
  if (el.localName === "input" && (f.type === "checkbox" || f.type === "radio")) return `${f.checked}:${f.value}`;
  if (el.localName === "input" && f.type === "file") return Array.from(f.files ?? [], (x) => `${x.name}:${x.size}`).join("\u0001");
  if (el.localName === "input" || el.localName === "textarea") return f.value ?? "";
  return "";
}

// 범위와 그 안 shadow root·같은 출처 iframe의 글자 전체(결제 문구 판정용 — textContent는 shadow 안 글자를 담지 않는다).
export function deepText(scope: Element): string {
  const parts = [scope.textContent ?? ""];
  for (const c of nestedContainersIn(scope)) parts.push(c.textContent ?? "");
  return parts.join(" ");
}
