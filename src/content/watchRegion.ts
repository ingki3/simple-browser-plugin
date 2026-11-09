// 반복 작업 확인 작전(#284)의 content 쪽: 작전 만들기용 영역 후보(regionOutline)와 작전 영역 읽기(readRegion).
// - 글자는 모두 modelText 경로(입력 칸 값·편집 영역·숨은 글자 제외, #43)로 만든다. 영역 뿌리가 보호 영역이면 찾지 못한 것으로 본다.
// - 선택자는 query_dom과 같은 정책(selectorBlock, #45)을 지나야 실행하고, 접근 가능한 같은 출처 루트에서만 찾는다.
// - 기준점은 모델이 준 글자를 그대로(공백 정규화·소문자) 포함 비교만 한다. 글자의 뜻은 보지 않는다.
import { getAccessibleRoots, type Root } from "./docs";
import { groupLabelInfo, inProtectedArea, modelText, modelTextInfo } from "./modelText";
import { skeletonOf } from "./skeleton";
import { composedChildren, walkComposed } from "./composed";
import { findClickables } from "./clickables";
import { selectorBlock } from "@/lib/selectorPolicy";
import { plainWord } from "@/lib/actionLog";
import { snapshotRole } from "@/lib/repeatTask";
import { capClickables, OUTLINE_MAX, REGION_MATCH_MAX, SHAPE_DEPTH, type OutlineItem, type RegionProbe, type RegionSpec } from "@/lib/repeatPlan";

const OUTLINE_SELECTOR =
  "main, article, section, aside, nav, form, table, ul, ol, dl, [role=main], [role=region], [role=list], [role=grid], [role=table], [role=feed], [role=tabpanel]";
const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6, [role=heading]";
// 개요 후보를 고를 때 보는 요소 수 상한(아주 큰 페이지에서 멈추지 않게).
const OUTLINE_SCAN_MAX = 400;
// 후보의 글자 수를 셀 때의 상한(전체 확인 글자 6000자를 넘으면 그 이상은 세지 않는다).
const OUTLINE_COUNT_MAX = 6001;
const SHORT = 80;

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// 선택자가 모든 접근 가능한 루트에서 맞는 요소(문서 순서, 루트 순서). 문법 오류면 null.
function matchAll(selector: string, roots: Root[], cap: number): Element[] | null {
  const out: Element[] = [];
  for (const root of roots) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = root.querySelectorAll(selector);
    } catch {
      return null;
    }
    for (const el of Array.from(nodes)) {
      out.push(el);
      if (out.length > cap) return out;
    }
  }
  return out;
}

// 요소 하나를 가리키는 짧은 이름(태그 + id·역할·class). 사람이 붙인 이름처럼 보이는 낱말만 쓴다(plainWord — 개인 정보가 든
// id·class를 선택자로 모델에 보내지 않게). 쓸 이름이 없으면 태그만.
function simpleParts(el: Element): string[] {
  const tag = el.localName;
  const out: string[] = [];
  const id = el.getAttribute("id");
  if (id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id) && plainWord(id)) out.push(`${tag}#${id}`);
  const role = el.getAttribute("role");
  if (role && /^[a-z]+$/.test(role)) out.push(`${tag}[role=${role}]`);
  const classes = Array.from(el.classList).filter((c) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(c) && plainWord(c)).slice(0, 2);
  if (classes.length) out.push(`${tag}.${classes.join(".")}`);
  return out;
}

function nthOfType(el: Element): string {
  let n = 1;
  for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === el.localName) n += 1;
  return `${el.localName}:nth-of-type(${n})`;
}

// 구조로 만든 선택자 중 정책을 지나고 모든 루트에서 el 하나에만 맞는 첫 것.
function selectorFor(el: Element, roots: Root[]): string | null {
  const unique = (sel: string) => {
    if (sel.length > 200 || selectorBlock(sel)) return false;
    const m = matchAll(sel, roots, 1);
    return !!m && m.length === 1 && m[0] === el;
  };
  const own = simpleParts(el);
  for (const s of own) if (unique(s)) return s;
  const tail = [...own, nthOfType(el)];
  // 부모 경로 1~2단계: "부모 > 자기", "조부모 > 부모 > 자기". 이름이 없는 조상은 태그:nth-of-type으로.
  const p1 = el.parentElement;
  if (!p1) return null;
  const p1Parts = [...simpleParts(p1), nthOfType(p1)];
  for (const head of p1Parts) for (const t of tail) if (unique(`${head} > ${t}`)) return `${head} > ${t}`;
  const p2 = p1.parentElement;
  if (!p2) return null;
  for (const head of [...simpleParts(p2), nthOfType(p2)]) {
    for (const mid of p1Parts) for (const t of tail) if (unique(`${head} > ${mid} > ${t}`)) return `${head} > ${mid} > ${t}`;
  }
  return null;
}

// 영역 뿌리 자신이나 합성 트리 안(shadow·slot에 배치된 노드 포함 — src/content/composed.ts)에 iframe·frame이 있는지.
// 끝까지 보지 못하면 있는 것으로 본다(덜 믿는 쪽). 프레임 안의 글자·버튼·모양은 영역 관측에 들지 않는다(프레임 문서 경계).
function containsFrame(el: Element): boolean {
  const isFrame = (e: Element) => e.localName === "iframe" || e.localName === "frame";
  if (isFrame(el)) return true;
  return walkComposed(el, isFrame) !== "done";
}

// 영역 안(합성 트리)의 제목 요소. 영역 글자와 같은 노드 집합에서 찾는다.
function composedHeadings(el: Element, max: number): Element[] {
  const out: Element[] = [];
  walkComposed(el, (e) => {
    if (e.matches(HEADING_SELECTOR)) out.push(e);
    return out.length >= max;
  });
  return out;
}

function firstHeadingText(el: Element): string {
  const [h] = composedHeadings(el, 1);
  return h ? modelText(h, SHORT) : "";
}

// 작전 만들기용 영역 후보. 보호 영역 안이거나 글자가 없는 것은 빼고, 글자가 많은 순서로 max개.
export function regionOutline(max = OUTLINE_MAX): OutlineItem[] {
  const roots = getAccessibleRoots();
  const seen = new Set<Element>();
  const cands: Element[] = [];
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll(OUTLINE_SELECTOR))) {
      if (cands.length >= OUTLINE_SCAN_MAX) break;
      if (!seen.has(el)) {
        seen.add(el);
        cands.push(el);
      }
    }
    for (const h of Array.from(root.querySelectorAll("h1, h2, h3"))) {
      if (cands.length >= OUTLINE_SCAN_MAX) break;
      const p = h.parentElement;
      if (p && p.localName !== "body" && p.localName !== "html" && !seen.has(p)) {
        seen.add(p);
        cands.push(p);
      }
    }
  }
  // 글자 수를 먼저 재고 많은 순서로 정렬한 뒤, 앞에서부터 선택자를 만들 수 있는 것만 max개(선택자 만들기가 비싸다).
  const sized: Array<{ el: Element; chars: number }> = [];
  for (const el of cands) {
    if (inProtectedArea(el) || containsFrame(el)) continue;
    const chars = modelTextInfo(el, OUTLINE_COUNT_MAX).text.length;
    if (chars) sized.push({ el, chars });
  }
  sized.sort((a, b) => b.chars - a.chars);
  const items: OutlineItem[] = [];
  for (const { el, chars } of sized) {
    if (items.length >= max) break;
    const selector = selectorFor(el, roots);
    if (!selector) continue;
    items.push({
      selector,
      tag: el.localName,
      role: el.getAttribute("role") ?? "",
      heading: firstHeadingText(el),
      label: groupLabelInfo(el, SHORT).text,
      chars,
      preview: modelText(el, SHORT),
    });
  }
  return items;
}

// 기준점이 맞는지. heading: 영역 안 제목이나 영역 바로 앞 형제 제목의 화면 글자에, label: 영역 뿌리의 이름표에 기준점 글자가
// 들어 있는지. element: 글자는 보지 않는다(모양 비교에서 맞춘다).
function anchorFits(el: Element, anchor: RegionSpec["anchor"]): boolean {
  if (anchor.where === "element") return true;
  const want = norm(anchor.text);
  if (!want) return false;
  if (anchor.where === "label") return norm(groupLabelInfo(el, 200).text).includes(want);
  const heads = composedHeadings(el, 30);
  const prev = el.previousElementSibling;
  if (prev && prev.matches(HEADING_SELECTOR)) heads.push(prev);
  if (el.matches(HEADING_SELECTOR)) heads.push(el);
  return heads.some((h) => norm(modelText(h, 200)).includes(want));
}

// 작전 영역 하나를 읽는다. 모양은 코드가 잰 값(tag·role·skeletonOf 깊이 SHAPE_DEPTH), 버튼은 영역 안의 것만.
export function readRegion(spec: RegionSpec): RegionProbe {
  if (typeof spec?.selector !== "string" || selectorBlock(spec.selector)) return { found: false, why: "blocked_selector" };
  const matches = matchAll(spec.selector, getAccessibleRoots(), REGION_MATCH_MAX);
  if (matches === null) return { found: false, why: "blocked_selector" };
  if (!matches.length) return { found: false, why: "no_match" };
  if (matches.length > REGION_MATCH_MAX) return { found: false, why: "too_many" };
  // 선택자와 기준점에 함께 맞는 요소가 정확히 하나여야 한다. 둘 이상이면 첫 것을 고르지 않는다(같은 모양의 영역이 앞에
  // 끼어들면 엉뚱한 영역을 보고 unmet을 확정할 수 있다) — 만들 때 거부, 확인 회차엔 전체 판단.
  const fits = matches.filter((m) => anchorFits(m, spec.anchor));
  if (!fits.length) return { found: false, why: "anchor_missing" };
  if (fits.length > 1) return { found: false, why: "ambiguous" };
  const el = fits[0];
  // 값 컨트롤·편집 영역·숨김 영역이 뿌리면(그 안이면) 읽지 않는다.
  if (inProtectedArea(el)) return { found: false, why: "protected" };
  // 프레임을 감싼 영역은 관측이 다 들지 않는다(만들 때 거부, 확인 회차엔 전체 판단).
  if (containsFrame(el)) return { found: false, why: "frame" };
  const info = modelTextInfo(el, spec.maxText);
  if (!info.text) return { found: false, why: "empty" };
  // 상한 + 1개를 찾아 넘쳤는지 본다. 버튼 목록이 잘린 영역은 글자가 잘린 것과 같게 cut(작전으로 받지 않고, 확인 회차엔
  // 전체 판단 — 잘린 목록 밖의 버튼만 바뀌면 영역 요청이 같아 잘못 unmet을 확정할 수 있다).
  const limit = Math.max(0, Math.floor(spec.limit));
  const found = findClickables({ limit: limit + 1 }, { within: el }).map((c) => ({
    text: c.text,
    role: snapshotRole(c.tag, c.role),
    ...(c.states ? { states: c.states } : {}),
  }));
  const { clickables, cut: buttonsCut } = capClickables(found, limit);
  return {
    found: true,
    text: info.text,
    cut: info.cut || buttonsCut,
    shape: { tag: el.localName, role: el.getAttribute("role") ?? "", skeleton: skeletonOf(el, SHAPE_DEPTH, composedChildren) },
    clickables,
  };
}
