import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { Session } from './session';
import type { ClientMsg } from '../shared/protocol';
import type { Point } from '../shared/drawing';

const PORT = Number(process.env.PORT ?? 8080);
const STROKES_PER_SECOND = 40;

interface Conn {
  socket: WebSocket;
  room: string;
  /** 세션이 아는 플레이어 id. join에서 cid를 확인한 뒤 확정된다. */
  actorId: string;
  strokeBudget: number;
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
    });
    sessions.set(room, s);
  }
  return s;
}

const wss = new WebSocketServer({ port: PORT });

// 스트로크 메시지 초당 상한을 매초 리필한다
setInterval(() => {
  for (const c of conns.values()) c.strokeBudget = STROKES_PER_SECOND;
}, 1000);

wss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const room = (url.searchParams.get('room') ?? '').trim().toUpperCase() || 'LOBBY';
  const conn: Conn = { socket, room, actorId: randomUUID(), strokeBudget: STROKES_PER_SECOND };
  conns.add(conn);

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

    session.handle(id, msg);
  });

  socket.on('close', () => {
    conns.delete(conn);
    // 이미 다른 연결이 이 자리를 넘겨받았다면(빠른 새로고침) 이탈로 처리하지 않는다
    if (actors.get(conn.actorId) === conn) {
      actors.delete(conn.actorId);
      session.disconnect(conn.actorId);
    }
  });
});

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

console.log(`PIZZA 서버가 ws://localhost:${PORT} 에서 대기 중`);
