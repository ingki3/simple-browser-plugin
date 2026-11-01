// 설정 페이지(옵션 탭, #127)의 묶음. 주소 해시(#model 등)로 고르고, 모르는 값이면 모델·연결.
export const SETTINGS_SECTIONS = ["model", "behavior", "sites", "records", "advanced"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
  model: "모델·연결",
  behavior: "동작",
  sites: "사이트",
  records: "기록",
  advanced: "고급",
};

export function isSettingsSection(v: unknown): v is SettingsSection {
  return typeof v === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(v);
}

export function settingsSectionOf(hash: string | undefined): SettingsSection {
  const v = (hash ?? "").replace(/^#/, "");
  return isSettingsSection(v) ? v : "model";
}
