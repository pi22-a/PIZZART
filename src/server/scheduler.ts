/**
 * 타이머를 주입해 테스트에서 시간을 직접 흘린다.
 * Session이 setTimeout을 직접 부르면 라운드 진행을 테스트할 방법이 없다.
 */
export interface Scheduler {
  /** ms 뒤에 fn을 부른다. 돌려주는 함수를 부르면 취소된다. */
  after(ms: number, fn: () => void): () => void;
}

export const realScheduler: Scheduler = {
  after(ms, fn) {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};
