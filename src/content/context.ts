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
  const headings = Array.from(doc.querySelectorAll("h1, h2"), (h) => h.textContent ?? "").join(" ").slice(0, 1000);
  return PAYMENT_TEXT_RE.test(`${route} ${doc.title} ${headings}`);
}

// 자신부터 위로 올라가며 selector에 맞는 첫 요소. shadow root 경계를 넘어 host로 올라간다.
export function closestAcross(el: Element, selector: string): Element | null {
  for (let cur: Element | null = el; cur; cur = eventParent(cur)) {
    if (cur.matches(selector)) return cur;
  }
  return null;
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
    const headings = Array.from(root.querySelectorAll("h1, h2"), (h) => h.textContent ?? "").join(" ").slice(0, 1000);
    if (PAYMENT_TEXT_RE.test(headings)) return true;
  }
  // 양식과 그 바깥 대화상자를 각각 본다(대화상자의 "결제 금액" 문구 아래 양식 속 '확인' 버튼).
  const dialog = closestAcross(el, 'dialog, [role="dialog"], [role="alertdialog"]');
  return [form, dialog].some((scope) => !!scope && PAYMENT_TEXT_RE.test((scope.textContent ?? "").slice(0, 2000)));
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

// 양식 없는 화면에서 대상 주변의 입력 칸 묶음: 감싼 대화상자, 아니면 위로 올라가며(최대 6단계, body 전)
// 처음 만나는 입력 칸이 든 조상. self는 그 자신(입력 칸)이 있어도 다른 칸이 있어야 범위로 본다.
export function formlessScope(el: Element): Element | null {
  const dialog = closestAcross(el, 'dialog, [role="dialog"], [role="alertdialog"]');
  if (dialog) return dialog;
  let cur: Element | null = eventParent(el);
  for (let depth = 0; cur && depth < 6; depth++, cur = eventParent(cur)) {
    if (cur === cur.ownerDocument.body) break;
    const fields = Array.from(cur.querySelectorAll("input, textarea, select")).filter((f) => f !== el);
    if (fields.length) return cur;
  }
  return null;
}
