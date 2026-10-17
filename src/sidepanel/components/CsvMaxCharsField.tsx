import { DEFAULT_CSV_MAX_CHARS, MAX_CSV_MAX_CHARS, MIN_CSV_MAX_CHARS } from "@/lib/messages";

interface Props {
  value: number;
  onChange: (value: number) => void;
}

// read_document가 CSV·TSV를 표로 읽을 때 모델에 넘기는 최대 글자 수. 저장할 때 범위 안으로 맞춘다.
export function CsvMaxCharsField({ value, onChange }: Props) {
  return (
    <label className="field">
      <span className="field-label">CSV 읽기 최대 글자 수</span>
      <div className="key-row">
        <input
          type="number"
          min={MIN_CSV_MAX_CHARS}
          max={MAX_CSV_MAX_CHARS}
          step={1000}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <button
          type="button"
          className="ghost-btn"
          disabled={value === DEFAULT_CSV_MAX_CHARS}
          onClick={() => onChange(DEFAULT_CSV_MAX_CHARS)}
        >
          기본값
        </button>
      </div>
      <span className="field-help">
        CSV·TSV 파일을 표로 읽을 때 이 글자 수까지만 읽고 나머지 행은 건너뜁니다({MIN_CSV_MAX_CHARS.toLocaleString()}~
        {MAX_CSV_MAX_CHARS.toLocaleString()}, 기본 {DEFAULT_CSV_MAX_CHARS.toLocaleString()}). 늘리면 더 많은 행을 읽지만
        요청마다 쓰는 토큰도 늘어납니다.
      </span>
    </label>
  );
}
