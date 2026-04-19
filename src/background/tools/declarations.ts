import { Type, type FunctionDeclaration } from "@google/genai";

export const functionDeclarations: FunctionDeclaration[] = [
  {
    name: "describe_page",
    description:
      "현재 활성 탭을 '관측'한다. URL과 제목, 주요 랜드마크(main/article/nav/aside/header/footer)별로 텍스트 미리보기·클릭 가능 요소 개수·샘플 링크 8개까지, 그리고 h1~h3 표제 목록을 반환한다. 어떤 페이지인지, 사용자의 요청이 이 페이지 맥락에서 무엇을 의미하는지 판단하는 근거로 쓴다. 페이지 상호작용이 필요한 요청의 첫 번째 툴 호출은 거의 항상 이것이다. 입력 없음.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "get_page_content",
    description:
      "현재 활성 탭의 본문 텍스트를 Readability 방식으로 추출한다. 페이지 내용을 요약·번역·질의할 때 근거로 사용한다. 입력 없음.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "translate_page",
    description:
      "현재 활성 탭의 가시 텍스트 노드를 대상 언어로 번역해 화면에 즉시 덮어쓴다. 사용자가 '이 페이지 번역해줘' 같은 페이지 전체 번역을 요청했을 때만 사용한다. 짧은 문장의 일반 번역은 이 도구를 쓰지 말고 채팅으로 직접 번역한다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        targetLang: {
          type: Type.STRING,
          description: "BCP-47 언어 코드. 예: 'ko', 'en', 'ja'.",
        },
        scope: {
          type: Type.STRING,
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
      "현재 활성 탭의 가시 입력 요소 (input/textarea/select)를 탐색해 id, 라벨, placeholder, 타입, 현재 값 목록을 반환한다. fill_form_fields를 호출하기 전에 반드시 먼저 호출해 필드 id를 확인한다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        onlyVisible: {
          type: Type.BOOLEAN,
          description: "보이는 필드만 반환할지 여부. 기본 true.",
        },
      },
    },
  },
  {
    name: "fill_form_fields",
    description:
      "사용자 승인 후 지정된 id의 폼 필드에 값을 채운다. id는 반드시 find_form_fields에서 받은 값을 사용해야 한다. 민감 작업이라 실행 전 사용자 승인 카드가 표시된다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        fills: {
          type: Type.ARRAY,
          description: "필드 id와 채울 값 쌍의 배열.",
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING, description: "find_form_fields가 반환한 필드 id" },
              value: { type: Type.STRING, description: "입력할 값" },
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
      type: Type.OBJECT,
      properties: {
        minWidth: {
          type: Type.NUMBER,
          description: "최소 너비(px). 이보다 작은 이미지는 제외. 기본 0.",
        },
      },
    },
  },
  {
    name: "download_images",
    description:
      "사용자 승인 후 지정된 URL들을 chrome.downloads로 저장한다. 민감 작업이라 실행 전 사용자 승인 카드가 표시된다. URL은 list_page_images에서 얻은 http(s) 주소여야 한다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        urls: {
          type: Type.ARRAY,
          description: "다운로드할 이미지 URL 배열 (http/https).",
          items: { type: Type.STRING },
        },
        folderPrefix: {
          type: Type.STRING,
          description: "저장 폴더 접두사. 미지정 시 설정값 사용.",
        },
      },
      required: ["urls"],
    },
  },
  {
    name: "query_dom",
    description:
      "CSS 선택자로 현재 활성 탭의 DOM 요소를 조회해 텍스트와 속성값을 반환한다. 특정 구조를 읽어야 할 때의 이스케이프 해치.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        selector: { type: Type.STRING, description: "CSS 선택자" },
        attr: { type: Type.STRING, description: "반환할 속성 이름 (선택)" },
        limit: { type: Type.NUMBER, description: "최대 결과 개수, 기본 50, 최대 200" },
      },
      required: ["selector"],
    },
  },
  {
    name: "find_clickables",
    description:
      "현재 활성 탭에서 클릭 가능한 요소(링크 a, button, role=button, role=link)를 문서 순서로 반환한다. 각 요소는 `region` 라벨(main/article/nav/aside/header/footer/other)과 `inViewport`(현재 화면에 보이는지) 정보를 포함해, 사이드바/헤더 같은 UI 크롬과 본문 콘텐츠를 구분할 수 있다. click_element 호출 전 반드시 먼저 호출한다. 사용자가 '첫 번째 아티클' 같은 콘텐츠 클릭을 요청하면 `region=main` 또는 `region=article`로 먼저 시도해 본문 영역만 본다. 뉴스레터 메일처럼 본문 속 링크가 목표라면 main/article 영역이 비어 있을 수 있으므로, 이 때는 필터 없이 다시 조회해 본문 텍스트(예: '읽기', 'Read more', 기사 제목)가 포함된 링크를 고른다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "텍스트/href 부분일치 필터(대소문자 무시).",
        },
        region: {
          type: Type.STRING,
          enum: ["main", "article", "nav", "aside", "header", "footer", "other"],
          description: "페이지 영역 필터. 본문 콘텐츠만 보려면 'main'이나 'article'.",
        },
        onlyViewport: {
          type: Type.BOOLEAN,
          description: "true면 현재 화면에 보이는 요소만 반환. 사용자가 '보이는 것 중에서'처럼 말하면 true.",
        },
        limit: {
          type: Type.NUMBER,
          description: "최대 결과 개수, 기본 50, 최대 200",
        },
      },
    },
  },
  {
    name: "click_element",
    description:
      "사용자 승인 후 find_clickables가 반환한 id의 요소를 클릭한다. 링크면 해당 링크로 이동, 버튼이면 동작 실행. 민감 작업이라 실행 전 승인 카드가 표시된다. id는 반드시 find_clickables에서 얻은 값이어야 한다.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING, description: "find_clickables가 반환한 요소 id" },
      },
      required: ["id"],
    },
  },
];
