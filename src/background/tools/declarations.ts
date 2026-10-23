import { QUERY_DOM_ATTRS } from "@/lib/modelText";

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const functionDeclarations: FunctionDeclaration[] = [
  {
    name: "describe_page",
    description:
      "현재 활성 탭을 '관측'한다. URL과 제목, 주요 랜드마크(main/article/nav/aside/header/footer)별로 텍스트 미리보기·클릭 가능 요소 개수·샘플 링크 8개까지, 그리고 h1~h3 표제 목록을 반환한다. 어떤 페이지인지, 사용자의 요청이 이 페이지 맥락에서 무엇을 의미하는지 판단하는 근거로 쓴다. 페이지 상호작용이 필요한 요청의 첫 번째 툴 호출은 거의 항상 이것이다. 입력 없음.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_page_content",
    description:
      "현재 활성 탭의 본문 텍스트를 Readability 방식으로 추출한다. 페이지 내용을 요약·번역·질의할 때 근거로 사용한다. 입력 없음.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_youtube_transcript",
    description:
      "현재 탭이 YouTube 영상 페이지(youtube.com/watch, /shorts/, /live/)일 때 영상의 자막 스크립트를 추출한다. YouTube의 '스크립트 표시' 패널을 열어 읽으며, 각 줄은 '[m:ss] 텍스트' 형식이다. 영상 요약·질의응답·특정 장면 찾기에 사용한다. 자막이 없는 영상이면 오류를 반환한다.",
    parameters: {
      type: "object",
      properties: {
        includeTimestamps: {
          type: "boolean",
          description: "각 줄 앞에 [m:ss] 타임스탬프를 붙일지. 기본 true.",
        },
        maxChars: {
          type: "number",
          description:
            "반환할 최대 글자 수. 기본 40000(CSV·TSV는 사용자 설정값), 최대 100000. CSV·TSV는 사용자가 더 많이 읽어 달라고 할 때만 지정한다.",
        },
      },
    },
  },
  {
    name: "list_file_links",
    description:
      "현재 페이지에서 파일 링크(첨부 파일·다운로드 링크)를 찾아 링크 글자, URL, 짐작한 형식을 반환한다. 페이지에 링크된 문서를 read_document로 읽기 전에 URL을 얻을 때 쓴다. 형식이 null이면 확장자 없는 다운로드 링크다. readable이 false인 링크(zip·구형 Office·이미지 등, ext에 확장자)는 read_document로 읽을 수 없고 download_files로 저장만 할 수 있다.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "링크 글자·파일 이름·URL에 이 말이 들어간 것만 고른다(대소문자 무시). 생략하면 전부.",
        },
        limit: {
          type: "number",
          description: "최대 개수. 기본 50, 최대 200.",
        },
      },
    },
  },
  {
    name: "read_other_tabs",
    description:
      "같은 창에 열린 다른 탭의 본문을 읽는다. 탭 목록은 보이지 않으며, 사용자가 승인 카드에서 읽을 탭을 직접 고른다(최대 5개). 사용자가 '다른 탭', '열어 둔 탭', '왼쪽 탭의 상품과 비교' 등을 말할 때 쓴다. 결과는 고른 탭마다 제목·사이트·본문(또는 읽지 못한 이유).",
    parameters: {
      type: "object",
      properties: {
        purpose: {
          type: "string",
          description: "무엇을 참고하려는지 사용자에게 보일 짧은 설명(예: '두 상품의 가격·사양 비교').",
        },
      },
      required: ["purpose"],
    },
  },
  {
    name: "read_linked_pages",
    description:
      "지금 페이지에 있는 링크(기사 등)를 탭 이동 없이 받아 와 본문을 읽는다(최대 8개). 뉴스 목록에서 관련 기사 여러 개를 요약할 때 쓴다. urls는 find_clickables·describe_page로 얻은 링크 주소 그대로. 페이지에 없는 주소는 읽지 않는다. 사용자가 승인 카드에서 읽을 링크를 고른다. 로그인 쿠키 없이 받는다. 같은 사이트 안 리다이렉트는 최대 3번 따라가고(finalUrl에 실제 주소), 다른 사이트로 가는 리다이렉트는 따라가지 않고 목적지를 redirectTo로 알린다 — 그 주소는 이번 요청 동안 urls에 넣어 다시 부를 수 있다(새 승인 카드). 쿠키 없는 요청을 막는 사이트(blocked=true)·자바스크립트로 그리는 페이지는 읽지 못할 수 있다. 결과는 링크마다 제목·본문(또는 읽지 못한 이유). short=true면 본문이 짧아 정보가 부족할 수 있다.",
    parameters: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "읽을 링크의 절대 주소(최대 8개)." },
      },
      required: ["urls"],
    },
  },
  {
    name: "read_document",
    description:
      "파일 URL을 내려받아 텍스트로 읽는다. 지원: Word(.docx)·Excel(.xlsx)·PowerPoint(.pptx)·OpenDocument(.odt/.ods/.odp)는 Markdown(제목·목록·표 유지), PDF는 쪽별 글자, 한글(.hwp/.hwpx)은 Markdown(병합 셀 표는 HTML), CSV/TSV는 표, TXT/MD는 원문. 확장자 없는 다운로드 링크(download.do?fileId=… 등)도 받은 뒤 형식을 판별한다. 페이지에 있는 파일 링크는 list_file_links로 URL을 먼저 얻는다. 이미지·스캔 PDF 속 글자는 읽지 못한다.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "파일의 http(s) URL(링크의 href 그대로).",
        },
        maxChars: {
          type: "number",
          description: "반환할 최대 글자 수. 기본 40000, 최대 100000.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "translate_page",
    description:
      "현재 활성 탭의 가시 텍스트 노드를 대상 언어로 번역해 화면에 즉시 덮어쓴다. 사용자가 '이 페이지 번역해줘' 같은 페이지 전체 번역을 요청했을 때만 사용한다. 짧은 문장의 일반 번역은 이 도구를 쓰지 말고 채팅으로 직접 번역한다.",
    parameters: {
      type: "object",
      properties: {
        targetLang: {
          type: "string",
          description: "BCP-47 언어 코드. 예: 'ko', 'en', 'ja'.",
        },
        scope: {
          type: "string",
          enum: ["visible", "article"],
          description: "번역 범위. 기본 'visible'은 보이는 모든 텍스트 노드, 'article'은 본문만.",
        },
      },
      required: ["targetLang"],
    },
  },
  {
    name: "find_form_fields",
    description:
      "현재 활성 탭의 보이는 입력 요소(input/textarea/select)를 탐색해 id, 라벨, placeholder, 타입을 반환한다. 사용자가 입력한 값은 돌려주지 않는다: 글자 칸은 값이 있는지(hasValue)만, checkbox·radio는 체크 여부(checked)만, select는 선택지의 보이는 글자(options)와 선택된 위치(selectedIndex, 개인정보 칸이면 생략)만 준다. 각 칸이 든 행·묶음의 화면 글자(context, 입력값 제외)를 함께 주므로 라벨 없는 칸(메일 목록의 행 체크박스 등)은 context로 구분한다. 화면에 보이지 않는 칸은 돌려주지 않는다. 다만 숨긴 checkbox·radio라도 연결된 보이는 label이 있으면 돌려준다(채우기는 다른 checkbox·radio와 같다). fill_form_fields를 호출하기 전에 반드시 먼저 호출해 필드 id를 확인한다.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "fill_form_fields",
    description:
      "사용자 승인 후 지정된 id의 폼 필드에 값을 채운다. id는 반드시 find_form_fields에서 받은 값을 사용해야 한다. 민감 작업이라 실행 전 사용자 승인 카드가 표시된다. 승인 카드를 띄울 때와 채우기 직전에 각 칸이 find_form_fields 때와 같은지 확인하며, 바뀐 칸은 채우지 않는다. 결과의 results에 칸마다 값이 실제로 반영됐는지(applied)가 담긴다.",
    parameters: {
      type: "object",
      properties: {
        fills: {
          type: "array",
          description: "필드 id와 채울 값 쌍의 배열.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "find_form_fields가 반환한 필드 id" },
              value: {
                type: "string",
                description:
                  "입력할 값. select는 options의 보이는 글자 그대로(정확히 하나와 같아야 함), checkbox·radio는 \"true\" 또는 \"false\".",
              },
            },
            required: ["id", "value"],
          },
        },
      },
      required: ["fills"],
    },
  },
  {
    name: "list_page_images",
    description: "현재 활성 탭의 이미지 URL과 메타데이터를 수집한다. 이미지 다운로드 전 목록 확인에 사용.",
    parameters: {
      type: "object",
      properties: {
        minWidth: {
          type: "number",
          description: "최소 너비(px). 이보다 작은 이미지는 제외. 기본 0.",
        },
      },
    },
  },
  {
    name: "download_images",
    description:
      "지금 페이지의 이미지를 저장한다. URL은 list_page_images가 준 주소 그대로 넘긴다(페이지에 없는 주소는 받지 않는다). 사용자가 승인 카드에서 저장할 이미지를 고르고(넘긴 이미지는 미리 체크됨), 고른 것만 저장한다. 결과는 항목별 저장 성공·실패(이유)와 저장 위치(폴더/파일 이름).",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          description: "저장할 이미지 URL 배열(list_page_images의 url 그대로). 사용자가 지정한 범위·조건에 맞는 것만.",
          items: { type: "string" },
        },
        folderPrefix: {
          type: "string",
          description: "저장 폴더 접두사. 미지정 시 설정값 사용.",
        },
      },
      required: ["urls"],
    },
  },
  {
    name: "download_files",
    description:
      "지금 페이지의 첨부·다운로드 파일 링크(PDF·엑셀·한글·zip 등)를 브라우저 다운로드로 저장한다(로그인 쿠키 포함). URL은 list_file_links가 준 주소(페이지 링크의 href) 그대로 넘긴다(페이지에 없는 주소는 받지 않는다, 최대 20개). 사용자가 승인 카드에서 받을 파일을 고르고(넘긴 링크는 미리 체크됨), 고른 것만 받는다. 파일 이름은 서버가 준 이름(Content-Disposition)·주소의 이름, 없으면 받은 형식으로 정한다. 결과는 항목별 저장 성공·실패(이유)와 저장 위치(폴더/파일 이름).",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          description: "받을 파일 링크 URL 배열(list_file_links의 url 그대로). 사용자가 지정한 조건(형식·순서 등)에 맞는 것만.",
          items: { type: "string" },
        },
        folderPrefix: {
          type: "string",
          description: "저장 폴더 접두사. 미지정 시 설정값 사용.",
        },
      },
      required: ["urls"],
    },
  },
  {
    name: "query_dom",
    description:
      "CSS 선택자로 현재 활성 탭의 DOM 요소를 조회해 화면 글자와 속성값을 반환한다. 특정 구조를 읽어야 할 때의 이스케이프 해치. 입력 칸·편집 영역·숨은 요소 안의 글자는 돌려주지 않는다.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS 선택자" },
        attr: {
          type: "string",
          enum: [...QUERY_DOM_ATTRS],
          description:
            "반환할 속성 이름(선택). 정해 둔 구조 속성만 받는다. 입력값 성격의 속성(value 등)·data-*·class는 받지 않는다.",
        },
        limit: { type: "number", description: "최대 결과 개수, 기본 50, 최대 200" },
      },
      required: ["selector"],
    },
  },
  {
    name: "navigate_to_url",
    description:
      "사용자 승인 후 현재 활성 탭을 지정한 웹 주소로 직접 이동한다. 사용자가 특정 URL이나 잘 알려진 사이트의 홈(예: 네이버, 구글)으로 이동해 달라고 명시적으로 요청했을 때 사용한다. 현재 페이지를 관측하거나 링크를 찾을 필요가 없다. 반드시 신뢰할 수 있는 완전한 http/https URL을 사용하고, 사이트 이름이 모호하거나 공식 도메인을 확신할 수 없으면 추측하지 말고 사용자에게 URL을 묻는다.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "이동할 전체 http/https URL. 예: https://www.naver.com/",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "find_clickables",
    description:
      "현재 활성 탭에서 클릭 가능한 요소(링크 a, button, role=button, role=link, 그리고 목록에서 고르는 위젯의 role=option·menuitem*·tab·combobox·aria-haspopup=listbox 트리거, input이 아닌 체크 위젯 role=checkbox·switch·radio)를 문서 순서로 반환한다. 글자가 같아도 요소마다 따로 반환하며, context(대상이 든 묶음의 화면 글자)와 states(selected·checked·expanded 등)로 구분한다. 펼친 트리거가 여럿이라 어느 위젯의 것인지 정할 수 없는 선택지는 반환하지 않는다. 각 요소는 `region` 라벨(main/article/nav/aside/header/footer/other)과 `inViewport`(현재 화면에 보이는지) 정보를 포함해, 사이드바/헤더 같은 UI 크롬과 본문 콘텐츠를 구분할 수 있다. click_element 호출 전 반드시 먼저 호출한다. 사용자가 '첫 번째 아티클' 같은 콘텐츠 클릭을 요청하면 `region=main` 또는 `region=article`로 먼저 시도해 본문 영역만 본다. 뉴스레터 메일처럼 본문 속 링크가 목표라면 main/article 영역이 비어 있을 수 있으므로, 이 때는 필터 없이 다시 조회해 본문 텍스트(예: '읽기', 'Read more', 기사 제목)가 포함된 링크를 고른다.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "텍스트/href 부분일치 필터(대소문자 무시). '|'로 여러 낱말을 주면 하나라도 맞는 요소를 맞은 낱말이 많은 순으로 반환한다(예: '주문|배송|마이페이지|my').",
        },
        region: {
          type: "string",
          enum: ["main", "article", "nav", "aside", "header", "footer", "other"],
          description: "페이지 영역 필터. 본문 콘텐츠만 보려면 'main'이나 'article'.",
        },
        onlyViewport: {
          type: "boolean",
          description: "true면 현재 화면에 보이는 요소만 반환. 사용자가 '보이는 것 중에서'처럼 말하면 true.",
        },
        limit: {
          type: "number",
          description: "최대 결과 개수, 기본 50, 최대 200",
        },
      },
    },
  },
  {
    name: "google_sheets_list",
    description:
      "Google Sheets 스프레드시트의 모든 시트(탭) 목록과 크기를 반환한다. 쓰기·읽기 전 구조 파악에 사용. 현재 탭 URL이 docs.google.com/spreadsheets/d/{ID}면 그 ID를 사용.",
    parameters: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "스프레드시트 ID (URL /d/{ID}/...)" },
      },
      required: ["spreadsheetId"],
    },
  },
  {
    name: "google_sheets_read_range",
    description:
      "Google Sheets의 특정 A1 표기 범위 값을 읽어온다. 예: 'Sheet1!A1:C20'. 시트 이름에 공백이 있으면 작은따옴표로 감싼다: \"'내 시트'!A1:B10\".",
    parameters: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string", description: "A1 표기 (예: Sheet1!A1:D50)" },
      },
      required: ["spreadsheetId", "range"],
    },
  },
  {
    name: "google_sheets_write_range",
    description:
      "민감. 사용자 승인 후 Google Sheets의 지정 범위에 2차원 배열을 덮어쓴다. 수식 허용(USER_ENTERED). 기존 값이 있으면 지워진다. 쓰기 전에 반드시 google_sheets_read_range 또는 google_sheets_list로 구조를 확인한다.",
    parameters: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string" },
        values: {
          type: "array",
          description: "행의 배열. 각 행은 문자열 배열.",
          items: { type: "array", items: { type: "string" } },
        },
      },
      required: ["spreadsheetId", "range", "values"],
    },
  },
  {
    name: "google_sheets_append_rows",
    description:
      "민감. 사용자 승인 후 Google Sheets의 지정 범위 테이블 끝에 행을 추가한다. 수식 허용.",
    parameters: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string", description: "기준 범위 (보통 'Sheet1!A:Z')" },
        values: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
        },
      },
      required: ["spreadsheetId", "range", "values"],
    },
  },
  {
    name: "google_sheets_write_markdown_table",
    description:
      "민감. markdown 표(헤더 + --- 구분 + 데이터 행)를 파싱해 Google Sheets 지정 범위에 쓴다. 모델이 자연어로 구상한 표를 한 번에 시트에 반영할 때 사용.",
    parameters: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string" },
        range: { type: "string", description: "좌상단 기준 셀 (예: 'Sheet1!A1')" },
        markdownTable: {
          type: "string",
          description: "markdown 파이프 표. 예: '| col1 | col2 |\\n|---|---|\\n| a | b |'",
        },
      },
      required: ["spreadsheetId", "range", "markdownTable"],
    },
  },
  {
    name: "google_drive_search",
    description:
      "Google Drive 검색. query는 Drive API의 q 문법을 그대로 따른다. 예: \"name contains 'Report' and mimeType='application/vnd.google-apps.document'\". 결과는 수정일 역순.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "number", description: "기본 20, 최대 50" },
      },
      required: ["query"],
    },
  },
  {
    name: "google_drive_list_recent",
    description:
      "Drive에서 최근 수정된 파일을 반환. mimeType으로 필터 가능 (예: 'application/vnd.google-apps.spreadsheet').",
    parameters: {
      type: "object",
      properties: {
        mimeType: { type: "string" },
        maxResults: { type: "number" },
      },
    },
  },
  {
    name: "google_drive_export",
    description:
      "Drive 파일을 지정 포맷으로 export해 텍스트(또는 바이너리 메타)를 반환. Docs → txt/pdf/md/docx, Sheets → csv/tsv/xlsx 등. 바이너리 포맷은 미리보기 없이 크기만 반환.",
    parameters: {
      type: "object",
      properties: {
        fileId: { type: "string" },
        format: {
          type: "string",
          enum: ["pdf", "txt", "csv", "tsv", "html", "md", "docx", "xlsx"],
        },
        maxChars: { type: "number", description: "텍스트 포맷 최대 글자 (기본 20000)" },
      },
      required: ["fileId", "format"],
    },
  },
  {
    name: "click_element",
    description:
      "사용자 승인 후 find_clickables가 반환한 id의 요소를 클릭한다. 링크면 해당 링크로 이동, 버튼이면 동작 실행. 민감 작업이라 실행 전 승인 카드가 표시된다. id는 반드시 find_clickables에서 얻은 값이어야 한다. 승인 카드를 띄울 때와 클릭 직전에 그 요소가 find_clickables 때와 같은지 확인하며, 바뀌었으면 누르지 않고 실패한다. 결과의 effect에 클릭 뒤 이동(navigation)·새 탭(newTab)·화면 변화(dom)가 담긴다.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "find_clickables가 반환한 요소 id" },
      },
      required: ["id"],
    },
  },
];
