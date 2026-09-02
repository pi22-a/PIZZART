/**
 * 판이 도는 동안 화면이 꺼지지 않게 잡아둔다.
 *
 * 그리는 시간이 120초다. 그동안 폰은 손을 안 대면 화면을 끈다 — 그리는 사람은 계속
 * 그으니 괜찮지만, **기다리는 사람들은 아무것도 안 한다.** 화면이 꺼졌다가 다시 켜면
 * 그 사이 회차가 넘어가 있고, 답을 낼 기회를 통째로 놓친다.
 *
 * 브라우저가 이걸 순순히 내주지 않는다는 점이 중요하다.
 *
 * - 사용자가 화면을 안 보고 있으면(탭 전환, 잠금) **브라우저가 알아서 놓아버린다.**
 *   그래서 돌아왔을 때 다시 잡아야 한다 — visibilitychange를 듣는 이유다.
 * - 되는 기기와 안 되는 기기가 갈린다. 안 되면 그냥 안 되는 것이고, 판은 그대로 돈다.
 *   화면이 안 꺼지는 것은 편의지 게임의 조건이 아니다.
 */

/** 타입 정의에 아직 없는 브라우저도 있어 최소한만 직접 적는다. */
interface Sentinel {
  release(): Promise<void>;
  released: boolean;
}
type WakeNav = Navigator & { wakeLock?: { request(t: 'screen'): Promise<Sentinel> } };

let sentinel: Sentinel | null = null;
let want = false;

async function acquire(): Promise<void> {
  if (!want || sentinel) return;
  const nav = navigator as WakeNav;
  if (!nav.wakeLock) return;
  try {
    sentinel = await nav.wakeLock.request('screen');
    // 브라우저가 놓아버린 뒤에도 우리 손에 든 것처럼 굴면 다시 잡을 수 없다.
    sentinel.released = false;
  } catch {
    // 배터리 절약 모드 등으로 거절될 수 있다. 조용히 넘어간다.
    sentinel = null;
  }
}

/** 화면을 깨어 있게 할지 정한다. 판이 도는 동안 true, 로비에서 false. */
export function keepAwake(on: boolean): void {
  want = on;
  if (on) {
    void acquire();
  } else if (sentinel) {
    void sentinel.release().catch(() => {});
    sentinel = null;
  }
}

// 화면을 다시 보면 브라우저가 놓았던 것을 되찾는다.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    sentinel = null;
    void acquire();
  }
});
