// 첨부 파일 이름 정하기(#48)에서 onDeterminingFilename 이벤트를 어느 실행의 어느 항목에 맞출지. chrome API 없이 계산한다.
//
// 힌트(저장 폴더·순번)는 실행(run)마다 소유하고 다운로드 id로 묶는다. 같은 주소를 두 실행이 다른 폴더로 받아도 서로의
// 힌트를 지우거나 가져가지 않는다. chrome.downloads.download()는 응답 헤더가 와서 내려받기 항목이 생긴 뒤에야 id를
// 돌려주므로 이름 정하기 이벤트가 그보다 먼저 올 수 있다. 그래서 내려받기를 시작하는 동안에는 그 주소의 "시작 중"
// 힌트를 두고, 이벤트가 그 주소이면서 아직 알려진 id가 아니면 그 시작의 것으로 본다. 같은 주소의 시작은 호출한 쪽이
// 한 번에 하나만 하도록 직렬화한다(다른 주소끼리는 동시에 시작해도 주소로 구분된다).

export interface NameHint {
  run: number;
  folder: string;
  index: number;
}

// 끝나지 않고 남은(이름 정하기 이벤트가 오지 않은) 힌트가 쌓이지 않게 하는 상한.
const MAX_BOUND = 200;

export class DownloadNameHints {
  private byId = new Map<number, NameHint>();
  // 이 확장이 이름 힌트 없이 시작한 내려받기(이미지 등). 시작 중인 첨부와 주소가 같아도 가져가지 않는다.
  private others = new Set<number>();
  private starting = new Map<string, { hint: NameHint; claimedBy: number | null }>();

  // 첨부 하나의 시작을 알린다(같은 주소의 시작은 직렬화된 구간 안에서 하나씩만).
  beginStart(url: string, hint: NameHint): void {
    this.starting.set(url, { hint, claimedBy: null });
  }

  // download()가 돌려준 id로 시작을 마친다. 시작에 실패했으면 id는 null.
  endStart(url: string, id: number | null): void {
    const s = this.starting.get(url);
    this.starting.delete(url);
    if (!s || id === null) return;
    // 이벤트가 먼저 와서 이미 쓴 힌트는 다시 묶지 않는다.
    if (s.claimedBy === id) return;
    this.byId.set(id, s.hint);
    while (this.byId.size > MAX_BOUND) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
  }

  // 힌트 없이 시작한 이 확장의 내려받기 id.
  noteOther(id: number): void {
    this.others.add(id);
    while (this.others.size > MAX_BOUND) {
      const oldest = this.others.values().next().value;
      if (oldest === undefined) break;
      this.others.delete(oldest);
    }
  }

  // onDeterminingFilename: 이 확장이 시작한 내려받기(id·주소)의 힌트. 없으면 null(이름을 바꾸지 않는다).
  // 한 번 쓴 힌트는 다시 쓰지 않는다.
  claim(id: number, url: string): NameHint | null {
    const known = this.byId.get(id);
    if (known) {
      this.byId.delete(id);
      return known;
    }
    if (this.others.has(id)) return null;
    const s = this.starting.get(url);
    if (s && s.claimedBy === null) {
      s.claimedBy = id;
      return s.hint;
    }
    return null;
  }

  // 끝난(완료·중단·취소) 내려받기의 힌트를 지운다. 그 실행이 소유한 것만 지운다. 아직 받는 중인 것은 남겨 두어
  // 실행이 먼저 끝나도(시간 초과) 나중에 오는 이름 정하기에서 쓴다.
  forget(run: number, ids: readonly number[]): void {
    for (const id of ids) {
      if (this.byId.get(id)?.run === run) this.byId.delete(id);
      this.others.delete(id);
    }
  }

  // 힌트가 남아 있는지(이름 정하기 리스너를 계속 둘지).
  get size(): number {
    return this.byId.size + this.starting.size;
  }
}
