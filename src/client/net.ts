import type { ClientMsg, ServerMsg } from '../shared/protocol';
import type { Point } from '../shared/glyph';

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
  private socket: WebSocket;
  private buffer: Point[] = [];
  private timer: number | null = null;
  private pending: ClientMsg[] = [];

  private statusFn: ((ok: boolean) => void) | null = null;

  constructor(room: string, private onMsg: (m: ServerMsg) => void) {
    this.socket = new WebSocket(socketUrl(room));
    this.socket.onmessage = (e) => this.onMsg(JSON.parse(e.data) as ServerMsg);
    this.socket.addEventListener('open', () => {
      this.drainPending();
      this.statusFn?.(true);
    });
    // 재연결은 다음 단계 작업이다. 지금은 끊겼다는 사실만 알린다 —
    // 조용히 죽은 페이지를 계속 만지는 것이 제일 나쁘다.
    this.socket.addEventListener('close', () => this.statusFn?.(false));
    this.socket.addEventListener('error', () => this.statusFn?.(false));
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
    // CLOSING / CLOSED — 보낼 방법이 없다
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
    this.send({ t: 'stroke', points: this.buffer });
    this.buffer = [];
  }
}
