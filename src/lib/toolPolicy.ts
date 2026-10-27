import type { ToolName } from "./messages.ts";

// 외부 본문 보호의 도구 분류. 모든 도구를 빠짐없이 분류한다(Record<ToolName>이라 새 도구를 추가하고
// 여기에 넣지 않으면 타입 검사가 실패한다).
// - bringsExternal: 실행하면 결과나 오류로 외부 유래 데이터(파일·문서 본문, 파일 이름, Google 응답 등)가
//   모델 문맥에 들어온다. 성공·실패와 관계없이 실행하면 대화의 외부 본문 보호를 켠다.
// - observeOnly: 지금 턴 탭을 읽기만 하고, 모델 인자에 따라 페이지가 관찰할 수 있는 상태(DOM 속성·이벤트·
//   포커스·클릭)를 바꾸지 않으며, 모델 유래 값을 밖으로 보내지 않는다. 보호가 켜진 대화에서도 승인 없이 쓴다.
//   find_clickables·find_form_fields는 대상 id를 content script 메모리에만 두고 사용자가 입력한 값을 돌려주지
//   않으므로(#43) 여기에 든다. get_youtube_transcript는 페이지 버튼을 누르므로 해당하지 않는다.
export interface ToolPolicy {
  bringsExternal: boolean;
  observeOnly: boolean;
}

const LOCAL_READ: ToolPolicy = { bringsExternal: false, observeOnly: true };
const ACTION: ToolPolicy = { bringsExternal: false, observeOnly: false };
const EXTERNAL: ToolPolicy = { bringsExternal: true, observeOnly: false };

export const TOOL_POLICY: Record<ToolName, ToolPolicy> = {
  describe_page: LOCAL_READ,
  get_page_content: LOCAL_READ,
  list_page_images: LOCAL_READ,
  list_file_links: LOCAL_READ,
  query_dom: LOCAL_READ,
  find_clickables: LOCAL_READ,
  find_form_fields: LOCAL_READ,
  get_youtube_transcript: ACTION,
  translate_page: ACTION,
  fill_form_fields: ACTION,
  click_element: ACTION,
  // 로그인 정보를 페이지에 넣고 제출한다. 결과에는 값을 싣지 않는다.
  sign_in: ACTION,
  navigate_to_url: ACTION,
  // 모델이 만든 자리 값을 저장한 링크의 사이트로 보낸다(외부 본문 보호 중에는 늘 묻는다).
  open_saved_link: ACTION,
  download_images: ACTION,
  // 페이지 캡처(#49): 전체 캡처는 스크롤·스타일을 잠시 바꾼다. 결과에는 확장이 정한 이름·크기만 싣는다.
  capture_page: ACTION,
  // 결과에 서버가 정한 파일 이름(Content-Disposition)·받은 형식이 실린다.
  download_files: EXTERNAL,
  read_document: EXTERNAL,
  // Google 도구는 읽기뿐 아니라 쓰기도 응답 메타데이터(updatedRange)와 오류의 응답 본문이 외부 데이터다.
  google_sheets_list: EXTERNAL,
  google_sheets_read_range: EXTERNAL,
  google_sheets_write_range: EXTERNAL,
  google_sheets_append_rows: EXTERNAL,
  google_sheets_write_markdown_table: EXTERNAL,
  google_drive_search: EXTERNAL,
  google_drive_list_recent: EXTERNAL,
  google_drive_export: EXTERNAL,
  // 사용자가 고른 다른 탭(다른 사이트)의 본문.
  read_other_tabs: EXTERNAL,
  // 링크한 페이지(다른 사이트일 수 있음)의 본문.
  read_linked_pages: EXTERNAL,
  // 작업 맡기기 카드(#123): 페이지를 건드리지 않고 사용자에게만 묻는다.
  confirm_task: LOCAL_READ,
};

// 외부 본문 보호가 켜진 대화에서 이 도구 호출에 승인 카드가 필요한지(관측 전용이 아니면 모두).
export function needsApprovalWhenProtected(tool: ToolName): boolean {
  return !TOOL_POLICY[tool].observeOnly;
}
