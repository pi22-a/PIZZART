// @vitest-environment jsdom
//
// 지우개의 **배선**을 확인한다. 지우는 계산 자체는 eraser.test.ts가 덮으므로 여기서는
// 포인터 이벤트가 경로로 바뀌어 서버까지 가는 길만 본다. 이 길이 끊기면 화면에서는
// 지워지는데 서버는 모르는, 새로고침하면 되살아나는 지우개가 된다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CircleCanvas } from '../src/client/canvas';
import { Net } from '../src/client/net';
import type { ClientMsg, ServerMsg } from '../src/shared/protocol';
import type { Point } from '../src/shared/drawing';

function makeCanvas(): HTMLCanvasElement {
  const el = document.createElement('canvas');
  document.body.appendChild(el);
  // 캔버스가 화면에서 1000×1000이면 clientX/Y가 그대로 캔버스 좌표가 된다
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 }) as DOMRect;
  (el as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = () => {};
  return el;
}

const ev = (type: string, x: number, y: number, buttons = 1) =>
  new MouseEvent(type, { clientX: x, clientY: y, buttons });

beforeEach(() => {
  // jsdom에는 캔버스 구현이 없다. 그리기 호출을 전부 삼키는 가짜 컨텍스트를 끼운다.
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  HTMLCanvasElement.prototype.getContext = () => ctx as never;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('원형 캔버스의 지우개 배선', () => {
  it('끌면 지나온 자리가 전부 경로로 나간다', () => {
    const el = makeCanvas();
    const canvas = new CircleCanvas(el, { interactive: true });
    const path: Point[] = [];
    canvas.onErasePoint((p) => path.push(p));
    canvas.setTool('eraser');

    el.dispatchEvent(ev('pointerdown', 400, 500));
    el.dispatchEvent(ev('pointermove', 450, 500));
    el.dispatchEvent(ev('pointermove', 500, 500));

    // 지운 것이 있든 없든 지나온 점은 다 보낸다 — 서버가 받는 경로가 내가 지나온
    // 경로와 같아야 두 쪽이 같은 자리를 지운다
    expect(path).toEqual([[400, 500], [450, 500], [500, 500]]);
  });

  it('뗄 때 경로를 끊는다', () => {
    const el = makeCanvas();
    const canvas = new CircleCanvas(el, { interactive: true });
    let ended = 0;
    canvas.onEraseEnd(() => { ended += 1; });
    canvas.setTool('eraser');

    el.dispatchEvent(ev('pointerdown', 400, 500));
    el.dispatchEvent(ev('pointerup', 400, 500, 0));

    // 안 끊으면 다음에 누른 자리와 여기가 이어져, 지나지도 않은 자리가 쓸려나간다
    expect(ended).toBe(1);
  });

  it('펜일 때는 지우개 경로가 안 나간다', () => {
    const el = makeCanvas();
    const canvas = new CircleCanvas(el, { interactive: true });
    const path: Point[] = [];
    canvas.onErasePoint((p) => path.push(p));

    el.dispatchEvent(ev('pointerdown', 400, 500));
    el.dispatchEvent(ev('pointermove', 450, 500));

    expect(path).toEqual([]);
  });

  it('지우개는 원 밖에서도 받는다', () => {
    // 잉크는 원 안에만 있으니 밖을 막을 이유가 없고, 막으면 테두리에 바짝 붙은 선을
    // 지우기가 유난히 어려워진다. 펜은 여전히 원 안에서만 시작한다.
    const el = makeCanvas();
    const canvas = new CircleCanvas(el, { interactive: true });
    const path: Point[] = [];
    canvas.onErasePoint((p) => path.push(p));
    canvas.setTool('eraser');

    el.dispatchEvent(ev('pointerdown', 20, 20)); // 원 밖 (중심에서 679)
    expect(path).toEqual([[20, 20]]);
  });
});

describe('지우개 경로 묶어 보내기', () => {
  class FakeSocket {
    static readonly OPEN = 1;
    readyState = 1;
    out: ClientMsg[] = [];
    onmessage: ((e: { data: string }) => void) | null = null;
    constructor(public url: string) { live = this; }
    send(raw: string): void { this.out.push(JSON.parse(raw) as ClientMsg); }
    addEventListener(): void {}
    close(): void {}
  }
  let live: FakeSocket;

  function newNet(): Net {
    vi.stubGlobal('WebSocket', FakeSocket);
    return new Net('room', (_m: ServerMsg) => {});
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('50ms마다 묶어 보낸다 — 포인터마다 보내면 초당 예산에 걸린다', () => {
    const net = newNet();
    net.pushErase([100, 100]);
    net.pushErase([110, 100]);
    net.pushErase([120, 100]);
    expect(live.out.length).toBe(0);

    vi.advanceTimersByTime(50);

    expect(live.out).toEqual([{ t: 'erase', path: [[100, 100], [110, 100], [120, 100]] }]);
  });

  it('묶음과 묶음 사이가 안 끊기게 마지막 점을 겹쳐 보낸다', () => {
    // 지우개는 점이 아니라 점과 점 **사이**를 지운다. 그냥 끊으면 묶음 경계의
    // 한 구간이 아무에게도 안 지워진 채로 얼룩이 된다.
    const net = newNet();
    net.pushErase([100, 100]);
    net.pushErase([110, 100]);
    vi.advanceTimersByTime(50);

    net.pushErase([120, 100]);
    vi.advanceTimersByTime(50);

    expect(live.out[1]).toEqual({ t: 'erase', path: [[110, 100], [120, 100]] });
  });

  it('뗄 때는 남은 것을 보내고 경로를 비운다', () => {
    const net = newNet();
    net.pushErase([100, 100]);
    net.endErase();
    expect(live.out).toEqual([{ t: 'erase', path: [[100, 100]] }]);

    // 비웠으므로 더 보낼 것이 없다 — 다음에 누른 자리와 이어지면 안 된다
    net.endErase();
    vi.advanceTimersByTime(100);
    expect(live.out.length).toBe(1);
  });
});
