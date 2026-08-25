import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { Session } from './session';
import { saveDrawing } from './gallery';
import type { ClientMsg } from '../shared/protocol';
import type { Point } from '../shared/drawing';
import { DOODLE_W, DOODLE_H } from '../shared/drawing';

const PORT = Number(process.env.PORT ?? 8080);
const STROKES_PER_SECOND = 40;
/**
 * 이야기 줄의 초당 상한.
 *
 * 획 예산을 같이 쓰지 않는다. 획은 초당 40개가 정상이지만 사람이 1초에 40줄을 칠 일은
 * 없으므로, 같은 예산을 주면 도배를 막는 값이 사실상 없는 것과 같다.
 */
const CHATS_PER_SECOND = 3;
/**
 * 살아있는지 확인하는 주기. 한 번 걸러도 답이 없으면 끊긴 것으로 본다.
 *
 * 15초였을 때는 회차(20초)마다 검사가 한 번씩 도는 셈이라, 잠깐 렉이 걸린 사람이
 * 회차마다 끊겼다 붙었다 했다. 유령을 늦게 알아채는 대가를 치르더라도
 * 멀쩡한 사람을 끊지 않는 쪽이 낫다 — 유령은 방장 승계와 인원 계산만 잠시 흐리지만,
 * 끊긴 사람은 그 회차를 통째로 잃는다.
 */
const HEARTBEAT_MS = 30000;

interface Conn {
  socket: WebSocket;
  room: string;
  /** 세션이 아는 플레이어 id. join에서 cid를 확인한 뒤 확정된다. */
  actorId: string;
  strokeBudget: number;
  chatBudget: number;
  /** 지난 ping에 답이 왔는가 */
  alive: boolean;
}

const sessions = new Map<string, Session>();
const conns = new Set<Conn>();
/** 플레이어 id → 현재 그 사람이 쓰고 있는 연결 */
const actors = new Map<string, Conn>();
/** `방:cid` → 플레이어 id. 새로고침해도 같은 자리로 돌아오게 한다. */
const seats = new Map<string, string>();

function sessionFor(room: string): Session {
  let s = sessions.get(room);
  if (!s) {
    s = new Session((playerId, msg) => {
      const c = actors.get(playerId);
      if (c && c.socket.readyState === WebSocket.OPEN) {
        c.socket.send(JSON.stringify(msg));
      }
    }, {
      // 라운드가 끝날 때마다 그림을 파일에 쌓는다. 나중에 '지난 그림 보기' 모드의 재료다.
      onDrawing: (rec) => saveDrawing({ ...rec, room } as typeof rec & { room: string }),
    });
    sessions.set(room, s);
  }
  return s;
}

const wss = new WebSocketServer({ port: PORT });

// 스트로크 메시지 초당 상한을 매초 리필한다
setInterval(() => {
  for (const c of conns.values()) {
    c.strokeBudget = STROKES_PER_SECOND;
    c.chatBudget = CHATS_PER_SECOND;
  }
}, 1000);

/**
 * 살아있는지 물어본다.
 *
 * 폰을 잠그거나 탭을 뒤로 넘기거나 와이파이를 벗어난 브라우저는 TCP를 반쯤 열어둔 채
 * 사라진다. 그러면 close가 영영 안 오고, connected가 true로 남아 방장 승계도
 * 인원 계산도 전부 유령을 붙잡고 돈다. 한 번 걸러도 pong이 없으면 끊어버린다
 * (terminate는 close 이벤트를 내므로 이탈 처리는 원래 길로 흘러간다).
 */
setInterval(() => {
  for (const c of conns.values()) {
    if (!c.alive) { c.socket.terminate(); continue; }
    c.alive = false;
    c.socket.ping();
  }
}, HEARTBEAT_MS);

wss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const room = (url.searchParams.get('room') ?? '').trim().toUpperCase() || 'LOBBY';
  const conn: Conn = {
    socket, room, actorId: randomUUID(),
    strokeBudget: STROKES_PER_SECOND, chatBudget: CHATS_PER_SECOND, alive: true,
  };
  conns.add(conn);
  socket.on('pong', () => { conn.alive = true; });
  // 소켓 오류에 듣는 사람이 없으면 EventEmitter가 그대로 던져 서버 전체가 죽는다.
  // 끊긴 연결은 어차피 바로 뒤에 close로 온다. 판이 멈추는 것보다 서버가 죽는 게 나쁘다.
  socket.on('error', () => {});

  const session = sessionFor(room);

  socket.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      return; // 조용히 무시
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'join') {
      // 같은 브라우저가 돌아왔다면 예전 자리를 그대로 쓴다
      const cid = typeof msg.cid === 'string' ? msg.cid.slice(0, 64) : '';
      const seatKey = `${room}:${cid}`;
      if (cid && seats.has(seatKey)) {
        conn.actorId = seats.get(seatKey)!;
      } else if (cid) {
        seats.set(seatKey, conn.actorId);
      }
      actors.set(conn.actorId, conn);
      const name = String(msg.name ?? '').trim().slice(0, 12) || '손님';
      session.join(conn.actorId, name);
      return;
    }

    const id = conn.actorId;

    if (msg.t === 'chat') {
      if (conn.chatBudget-- <= 0) return;
      if (typeof msg.text !== 'string') return;
      // 길이와 단계 확인은 세션이 한다. 여기서는 형식과 빈도만 본다.
      session.chat(id, msg.text);
      return;
    }

    if (msg.t === 'stroke') {
      if (conn.strokeBudget-- <= 0) return;
      if (!Array.isArray(msg.points)) return;
      const clean = msg.points
        .filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
        .map(([x, y]) => [clamp(Math.round(x), 0, 1000), clamp(Math.round(y), 0, 1000)] as Point);
      if (clean.length === 0) return;
      session.addStroke(id, clean);
      return;
    }

    // 낙서도 그리기와 같은 예산을 쓴다. 한 사람이 동시에 둘을 그릴 일은 없고,
    // 예산을 따로 주면 낙서로 대역폭을 밀어 넣는 길이 하나 더 생긴다.
    if (msg.t === 'doodle') {
      if (conn.strokeBudget-- <= 0) return;
      if (!Array.isArray(msg.points)) return;
      const clean = msg.points
        .filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
        .map(([x, y]) => [clamp(Math.round(x), 0, DOODLE_W), clamp(Math.round(y), 0, DOODLE_H)] as Point);
      if (clean.length < 2) return;
      // 색은 세션에서 형식을 검사한다. 여기서는 문자열인지만 본다.
      session.addDoodle(id, clean, typeof msg.color === 'string' ? msg.color : '');
      return;
    }

    session.handle(id, msg);
  });

  socket.on('close', () => {
    conns.delete(conn);
    // 이미 다른 연결이 이 자리를 넘겨받았다면(빠른 새로고침) 이탈로 처리하지 않는다
    if (actors.get(conn.actorId) !== conn) return;
    actors.delete(conn.actorId);
    session.disconnect(conn.actorId);

    // 마지막 사람이 나가면 방을 버린다. 안 버리면 끝난 판이 방 코드에 눌러앉아,
    // 단톡방에 뿌린 그 링크를 다시 열었을 때 예전 순위 화면으로 떨어진다.
    if (session.connectedCount === 0) {
      sessions.delete(room);
      for (const key of [...seats.keys()]) {
        if (key.startsWith(`${room}:`)) seats.delete(key);
      }
    }
  });
});

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

console.log(`PIZZA 서버가 ws://localhost:${PORT} 에서 대기 중`);
