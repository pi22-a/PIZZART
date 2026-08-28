import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { DEFAULT_COLOR } from '../shared/palette';
import type { Point } from '../shared/drawing';

const FLUSH_MS = 50;

/**
 * 웹소켓 주소를 지금 페이지 주소에서 끌어낸다.
 *
 * 포트를 박아두면 배포하거나 터널을 뚫는 순간 깨진다. 그리고 https 페이지에서
 * 평문 ws:// 는 브라우저가 막으므로(mixed content) 스킴도 페이지를 따라가야 한다.
 * 개발 중에는 vite가 /ws 를 게임 서버로 넘겨준다 (vite.config.ts 참조).
 */
export function socketUrl(room: string): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws?room=${encodeURIComponent(room)}`;
}

export class Net {
  private socket!: WebSocket;
  private buffer: Point[] = [];
  private timer: number | null = null;
  private pending: ClientMsg[] = [];

  private statusFn: ((ok: boolean) => void) | null = null;

  /** 다시 붙을 때 서버에 나를 알리는 방법. 없으면 붙기만 하고 자리를 못 찾는다. */
  private hello: (() => ClientMsg) | null = null;
  /** 몇 번째 재시도인가. 붙는 순간 0으로 돌아간다. */
  private tries = 0;
  private retryTimer: number | null = null;
  /** 더 붙지 않는다. 강퇴당했거나 방을 떠난 경우다. */
  private done = false;

  constructor(private room: string, private onMsg: (m: ServerMsg) => void) {
    this.connect();
  }

  /**
   * 다시 붙었을 때 보낼 인사를 등록한다.
   *
   * 서버는 같은 cid로 join을 받으면 원래 자리에 앉히고 그 라운드에 준 것을 전부
   * 다시 보내준다(session.restore). 그래서 재연결은 사실상 join 한 번이면 끝난다 —
   * 막혀 있던 것은 그 join을 다시 보낼 사람이 없다는 것뿐이었다.
   */
  onReconnect(hello: () => ClientMsg): void {
    this.hello = hello;
  }

  /** 더 이상 붙지 않는다. 강퇴처럼 돌아가면 안 되는 자리에서 부른다. */
  stop(): void {
    this.done = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private connect(): void {
    this.socket = new WebSocket(socketUrl(this.room));
    this.socket.onmessage = (e) => this.onMsg(JSON.parse(e.data) as ServerMsg);
    this.socket.addEventListener('open', () => {
      const again = this.tries > 0;
      this.tries = 0;
      // 다시 붙은 것이면 나를 먼저 알린다. 그래야 서버가 자리를 찾아주고,
      // 그 뒤에야 밀려 있던 것을 보낼 자격이 생긴다.
      if (again && this.hello) this.socket.send(JSON.stringify(this.hello()));
      this.drainPending();
      this.statusFn?.(true);
    });
    this.socket.addEventListener('close', () => this.retry());
    this.socket.addEventListener('error', () => this.retry());
  }

  /**
   * 0.5초부터 두 배씩 늘려 10초까지. 끝없이 시도한다 —
   * 잠깐 끊긴 사람에게 "새로고침하세요"라고 하는 것이 제일 나쁘다.
   */
  private retry(): void {
    if (this.done || this.retryTimer !== null) return;
    this.statusFn?.(false);
    /*
     * 밀려 있던 것을 버린다.
     *
     * 끊긴 사이에 친 답이 나중에 되살아나면 이미 지난 회차의 답으로 채점된다.
     * 획도 마찬가지다 — 그 사이 라운드가 넘어갔으면 남의 그림에 선이 그어진다.
     */
    this.pending = [];
    this.buffer = [];
    const wait = Math.min(10_000, 500 * 2 ** this.tries);
    this.tries++;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (!this.done) this.connect();
    }, wait);
  }

  /** 지금 서버에 붙어 있는가. 끊긴 채로 뭘 보내봐야 조용히 사라진다. */
  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  onStatus(fn: (ok: boolean) => void): void {
    this.statusFn = fn;
  }

  /**
   * 소켓이 아직 안 열렸으면 큐에 담았다가 열릴 때 보낸다.
   * 그냥 버리면 접속 직후 그은 획이 소리 없이 사라진다.
   */
  send(m: ClientMsg): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(m));
      return;
    }
    if (this.socket.readyState === WebSocket.CONNECTING) {
      this.pending.push(m);
      return;
    }
    // CLOSING / CLOSED — 다시 붙는 중이다. 그때 밀린 것은 버린다(retry 참조).
  }

  private drainPending(): void {
    const queued = this.pending;
    this.pending = [];
    for (const m of queued) this.socket.send(JSON.stringify(m));
  }

  /** 점을 모았다가 50ms마다 한 번에 보낸다. */
  pushPoint(p: Point): void {
    this.buffer.push(p);
    if (this.timer === null) {
      this.timer = window.setTimeout(() => this.flush(), FLUSH_MS);
    }
  }

  endStroke(): void {
    this.flush();
  }

  private flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    this.send({ t: 'stroke', points: this.buffer, color: DEFAULT_COLOR });
    this.buffer = [];
  }
}
