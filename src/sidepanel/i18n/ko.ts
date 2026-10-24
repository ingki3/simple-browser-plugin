export const KO = {
  appTitle: "간편 도우미",
  composerPlaceholder: "무엇을 도와드릴까요?",
  send: "보내기",
  abort: "중단",
  settings: "설정",
  newChat: "새 대화",
  emptyState: "페이지에 대해 질문하거나 작업을 요청해 보세요.\n예: \"이 페이지 번역해줘\", \"빈 입력칸 채워줘\", \"이미지 다 다운받아줘\"",
  toolConfirmTitle: "도구 실행 확인",
  // 직접 조작할 사이트의 손 넘기기 카드(0.2.2).
  handoffTitle: "직접 해 주세요",
  handoffDone: "했어요",
  approve: "승인",
  approveChoices: "고른 항목 읽기",
  // 저장 카드(이미지·첨부 파일, #48)의 승인 버튼.
  approveChoicesSave: "고른 항목 저장",
  approveLinksThisTurn: "승인 + 이번 요청 동안 링크 이동 묻지 않기",
  approveLinksThisTurnHelp:
    "이번 요청이 끝날 때까지 같은 사이트 안의 일반 링크(다른 페이지로 가는 <a> 링크)는 묻지 않고 누릅니다. 버튼·양식 제출·다른 사이트로 가는 링크·개인정보가 채워진 양식은 계속 묻습니다.",
  approveToolThisChat: "승인 + 이번 대화 동안 이 도구 묻지 않기",
  approveUrlsThisChat: "승인 + 이 주소는 이번 대화에서 다시 묻지 않기",
  approveUrlsThisChatHelp:
    "카드에 보인 주소(글자 그대로)가 전화번호 같은 개인정보 모양으로 걸려 묻는 경우, 이번 대화에서는 그 주소 때문에 다시 묻지 않습니다. 다른 주소·결제·비밀번호·개인정보 칸·다른 사이트·되돌리기 어려운 동작은 계속 묻습니다.",
  // 도구별 허락 범위 설명(버튼 title). 대상 밖 도구에는 제안이 뜨지 않는다(#53).
  chatGrantHelp: {
    read_linked_pages:
      "이번 대화가 끝날 때까지(새 대화·확장 재시작이면 끝) 지금 페이지에 있는 같은 사이트 링크는 묻지 않고 쿠키 없이 읽습니다. 다른 사이트·결제·개인정보 신호가 있는 링크나 페이지에 없는 주소가 섞이면 계속 묻습니다.",
    translate_page:
      "이번 대화가 끝날 때까지 페이지 번역은 묻지 않습니다. 외부 문서 내용을 읽은 대화에서는 계속 묻습니다.",
    download_images:
      "이번 대화가 끝날 때까지 같은 폴더에 지금 페이지의 이미지를 저장할 때는 묻지 않고 도우미가 고른 이미지만 저장합니다. 이때는 쿠키 없이 직접 받은 이미지만 저장합니다. 다른 폴더, 페이지에 없는 주소, 리다이렉트하거나 로그인이 필요한 주소, 결제·개인정보 신호가 있는 주소, 외부 문서 내용을 읽은 대화에서는 계속 묻습니다.",
  },
  chatGrantBarLabel: "이번 대화에서 묻지 않음",
  chatGrantRevoke: "눌러서 취소",
  chatGrantToolNames: {
    read_linked_pages: "링크 읽기",
    translate_page: "번역",
    download_images: "이미지 저장",
  },
  cancel: "취소",
  errorMissingKey: "API 키가 설정되지 않았습니다. 오른쪽 위 설정에서 OpenRouter API 키를 입력해 주세요.",
  errorGeneric: "요청에 실패했습니다.",
  settingsTitle: "설정",
  apiKeyLabel: "OpenRouter API 키",
  apiKeyHelp: "OpenRouter 키는 이 기기의 chrome.storage.local에 평문으로 저장됩니다.",
  apiKeyShow: "표시",
  apiKeyHide: "숨김",
  modelLabel: "모델",
  systemPromptLabel: "기본 시스템 지침",
  systemPromptHelp: "모든 대화에 적용됩니다. 내부 안전 규칙과 도구 사용 규칙은 변경하지 않습니다.",
  translationLangLabel: "번역 대상 언어 (BCP-47)",
  downloadFolderLabel: "다운로드 폴더 접두사",
  maxToolHopsLabel: "도구 호출 순환 한도",
  maxToolHopsHelp:
    "한 요청에서 에이전트가 도구를 연속 호출할 수 있는 최대 횟수 (1~100, 기본 16). 한도에 닿으면 더 진행할지 묻습니다.",
  hopLimitTitle: "도구 호출 한도에 닿음",
  hopLimitStop: "그만하고 지금까지로 답하기",
  hopProgressLabel: "단계",
  save: "저장",
  saved: "저장됨",
  close: "닫기",
  streamingLabel: "응답 생성 중…",
  thinkingLabel: "생각 중…",
};

export type KoKey = keyof typeof KO;
