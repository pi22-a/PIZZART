import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { normalizeRoomCode } from '../shared/room';
import { hasProfanity } from './profanity';
import { serveStatic } from './static';
import { Session } from './session';
import { saveDrawing } from './gallery';
import type { ClientMsg, RoomInfo, ServerMsg } from '../shared/protocol';
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

/**
 * 로비에 서 있는 연결들. 방에 들어가지 않은 사람이다(주소에 ?room= 이 없다).
 * 방 목록만 받아 보고, 방을 만들거나 골라 들어간다.
 */
const lobbyConns = new Set<Conn>();

/** 강퇴당한 브라우저. 방마다 따로 센다 — 한 방에서 쫓겨났다고 다른 방까지 막을 이유는 없다. */
const banned = new Map<string, Set<string>>();

/** 방을 만들고 그 사람이 도착하기 전까지 비워둘 시간. 이 안에는 빈 방으로 지우지 않는다. */
const ROOM_GRACE_MS = 60_000;

/** 헷갈리는 글자(0/O, 1/I)를 뺀 방 코드. 통화로 불러줄 수 있어야 한다. */
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRoomCode(): string {
  for (let tries = 0; tries < 50; tries++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!sessions.has(code)) return code;
  }
  return `R${Date.now().toString(36).toUpperCase().slice(-5)}`;
}

function roomList(): RoomInfo[] {
  return [...sessions.entries()]
    .map(([code, s]) => ({
      code,
      // 이름은 세션이 들고 있다(join에서 한 번 정한다). 여기서 지어내면 방 안에서
      // 보이는 이름과 목록의 이름이 어긋난다.
      name: s.name || '방',
      count: s.connectedCount,
      max: s.capacity,
      phase: s.phase,
      round: s.roundNow,
      totalRounds: s.totalRounds,
      locked: s.locked,
    }))
    // 아무도 없는 방은 목록에 띄우지 않는다. 만든 사람이 아직 도착 중일 뿐이다.
    .filter((r) => r.count > 0)
    .sort((a, b) => (a.phase === 'lobby' ? 0 : 1) - (b.phase === 'lobby' ? 0 : 1) || b.count - a.count);
}

let listTimer: NodeJS.Timeout | null = null;
/**
 * 방 목록이 바뀌었음을 로비에 알린다.
 *
 * 한 번의 입장이 join·broadcastRoom 등으로 여러 번 이 함수를 부르므로 한 박자 모아 보낸다.
 * 목록은 몇 줄짜리지만 사람이 몰리면 초당 수십 번이 되고, 그걸 그대로 흘리면
 * 로비에 서 있는 사람들의 화면이 쉴 새 없이 다시 그려진다.
 */
function notifyLobby(): void {
  if (listTimer || lobbyConns.size === 0) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    const msg: ServerMsg = { t: 'roomList', rooms: roomList() };
    const line = JSON.stringify(msg);
    for (const c of lobbyConns) {
      if (c.socket.readyState === WebSocket.OPEN) c.socket.send(line);
    }
  }, 120);
}

/** 방이 언제부터 비어 있었나. 잠깐 비는 것과 정말 끝난 것을 가른다. */
const emptyAt = new Map<string, number>();

/**
 * 오래 비어 있는 방을 치운다.
 *
 * 마지막 사람이 나가는 그 순간에 지우지 않는다. 전원이 새로고침하면 잠깐 0명이 되는데,
 * 그때 지우면 방 이름도 점수도 통째로 날아가고 돌아온 사람들은 낯선 빈 방에 떨어진다.
 * 대신 한동안 비어 있으면 치운다 — 끝난 판이 방 코드에 눌러앉으면, 단톡방에 뿌린
 * 그 링크를 다시 열었을 때 예전 순위 화면으로 떨어진다.
 */
function sweepEmptyRooms(): void {
  const now = Date.now();
  for (const [code, s] of [...sessions.entries()]) {
    if (s.connectedCount > 0) { emptyAt.delete(code); continue; }
    const since = emptyAt.get(code) ?? now;
    emptyAt.set(code, since);
    if (now - since < ROOM_GRACE_MS) continue;
    if (now - s.bornAt < ROOM_GRACE_MS) continue;
    sessions.delete(code);
    banned.delete(code);
    emptyAt.delete(code);
    for (const key of [...seats.keys()]) {
      if (key.startsWith(`${code}:`)) seats.delete(key);
    }
  }
  notifyLobby();
}
setInterval(sweepEmptyRooms, 30_000);

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
    s.code = room;
    sessions.set(room, s);
  }
  return s;
}

/*
 * 화면과 웹소켓을 한 포트에서 같이 낸다.
 *
 * 개발 중에는 dist/가 없으므로 static이 아무 일도 안 하고, Vite가 화면을 맡아 /ws만
 * 여기로 넘겨준다. 프로덕션에서는 빌드해 두면 이 한 프로세스가 전부 처리한다 —
 * 앞에 웹서버를 따로 세울 필요가 없어 관리할 프로세스가 하나로 줄어든다.
 */
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
const static_ = serveStatic(dist);

const http = createServer((req, res) => {
  /*
   * 요청 하나가 서버를 내리지 못하게 한다.
   *
   * 노드는 요청 처리 중에 던져진 예외를 잡아주지 않는다 — 그대로 프로세스가 죽고,
   * 이 게임은 방 상태가 메모리에만 있으므로 **돌던 판이 전부 날아간다.** 화면을 내주다
   * 나는 실패는 그 대가를 치를 일이 아니다.
   */
  try {
    if (static_(req, res)) return;
    // dist가 없는 개발 중에 여기로 오는 것은 대개 /ws 오폭이다. 조용히 404를 준다.
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('없는 주소입니다');
  } catch (e) {
    console.error('[화면 서빙 실패]', req.url, e);
    if (!res.headersSent) res.writeHead(500).end();
    else res.end();
  }
});

const wss = new WebSocketServer({ server: http });
http.listen(PORT);

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
  // 주소에 ?room= 이 없으면 로비다. 예전에는 이 자리를 'LOBBY'라는 방 하나로 때웠는데,
  // 그러면 로비가 말만 로비지 다른 방과 구별이 안 됐다.
  // 들어오는 문에서 한 번 손질한다. 이 값이 방 열쇠이자 자리 지도의 열쇠라,
  // 여기서 정리해두면 뒤쪽 전부가 짧고 얌전한 코드만 보게 된다.
  const room = normalizeRoomCode(url.searchParams.get('room') ?? '');
  const conn: Conn = {
    socket, room, actorId: randomUUID(),
    strokeBudget: STROKES_PER_SECOND, chatBudget: CHATS_PER_SECOND, alive: true,
  };
  conns.add(conn);
  socket.on('pong', () => { conn.alive = true; });
  // 소켓 오류에 듣는 사람이 없으면 EventEmitter가 그대로 던져 서버 전체가 죽는다.
  // 끊긴 연결은 어차피 바로 뒤에 close로 온다. 판이 멈추는 것보다 서버가 죽는 게 나쁘다.
  socket.on('error', () => {});

  // ── 로비: 방 목록을 보고, 방을 만든다. 게임 세션에는 붙지 않는다. ──
  if (!room) {
    lobbyConns.add(conn);
    socket.send(JSON.stringify({ t: 'roomList', rooms: roomList() } satisfies ServerMsg));
    socket.on('message', (raw) => {
      let msg: ClientMsg;
      try { msg = JSON.parse(String(raw)) as ClientMsg; } catch { return; }
      if (!msg) return;
      if (msg.t === 'rooms') {
        socket.send(JSON.stringify({ t: 'roomList', rooms: roomList() } satisfies ServerMsg));
        return;
      }
      if (msg.t !== 'createRoom') return;
      // 방 제목은 목록에 걸려 아무 상관 없는 사람 눈에까지 든다. 가리지 않고 되돌린다.
      const wanted = String(msg.name ?? '').trim().slice(0, 20);
      if (hasProfanity(wanted)) {
        socket.send(JSON.stringify({ t: 'error', msg: '방 제목에 쓸 수 없는 말이 있습니다', kind: 'roomName' } satisfies ServerMsg));
        return;
      }
      const code = newRoomCode();
      const s = sessionFor(code);
      s.name = wanted || '새 방';
      socket.send(JSON.stringify({ t: 'roomCreated', room: code } satisfies ServerMsg));
      notifyLobby();
    });
    socket.on('close', () => { conns.delete(conn); lobbyConns.delete(conn); });
    return;
  }

  const session = sessionFor(room);
  session.code = room;

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
      const returning = Boolean(cid) && seats.has(seatKey);

      // 강퇴당한 브라우저는 이 방에 못 들어온다. 새 창을 열면 뚫리지만, 그건 계정이 없는
      // 웹에서는 어차피 못 막는다. 여기서 막는 것은 '그냥 다시 들어오는 것'이다.
      if (cid && banned.get(room)?.has(cid)) {
        socket.send(JSON.stringify({ t: 'kicked', msg: '이 방에서 내보내졌습니다' } satisfies ServerMsg));
        return;
      }
      // 잠긴 방에는 새 사람만 못 들어온다. 끊겼다 돌아오는 사람은 통과시킨다 —
      // 잠금은 모르는 사람을 막자는 것이지 친구를 내쫓자는 것이 아니다.
      if (!returning && session.locked) {
        socket.send(JSON.stringify({ t: 'kicked', msg: '방장이 입장을 막아두었습니다' } satisfies ServerMsg));
        return;
      }

      if (returning) {
        conn.actorId = seats.get(seatKey)!;
      } else if (cid) {
        seats.set(seatKey, conn.actorId);
      }
      actors.set(conn.actorId, conn);
      const wantedName = String(msg.name ?? '').trim().slice(0, 12);
      // 이름은 판이 끝날 때까지 결과 화면과 이야기판에 계속 남는다. 별표로 가려두면
      // 그 별표가 판 내내 따라다니므로, 아예 안 받고 이유를 알려준다.
      if (hasProfanity(wantedName)) {
        socket.send(JSON.stringify({ t: 'error', msg: '이름에 쓸 수 없는 말이 있습니다', kind: 'name' } satisfies ServerMsg));
        return;
      }
      const name = wantedName || '손님';
      session.join(conn.actorId, name);
      notifyLobby();
      return;
    }

    const id = conn.actorId;

    if (msg.t === 'kick') {
      const target = String(msg.playerId ?? '');
      if (!session.kick(id, target)) return;
      // 그 브라우저를 이 방에 한해 막고, 새 사람이 못 들어오게 방을 잠근다.
      // 내보내자마자 다시 들어오면 내보낸 의미가 없다 — 방장이 언제든 풀 수 있다.
      for (const [key, actorId] of seats) {
        if (actorId === target && key.startsWith(`${room}:`)) {
          const cid = key.slice(room.length + 1);
          if (!banned.has(room)) banned.set(room, new Set());
          banned.get(room)!.add(cid);
          seats.delete(key);
        }
      }
      session.setLock(id, true);
      const victim = actors.get(target);
      if (victim?.socket.readyState === WebSocket.OPEN) {
        victim.socket.send(JSON.stringify({ t: 'kicked', msg: '방장이 내보냈습니다' } satisfies ServerMsg));
      }
      notifyLobby();
      return;
    }

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
      // 색은 세션이 팔레트와 대조한다. 여기서는 문자열인지만 본다.
      session.addStroke(id, clean, typeof msg.color === 'string' ? msg.color : '');
      return;
    }

    // 지우개 경로도 획과 같은 예산을 쓴다. 그리기와 지우기를 동시에 할 수는 없고,
    // 예산을 따로 주면 지우개로 대역폭을 밀어 넣는 길이 하나 더 생긴다.
    //
    // 좌표를 여기서 거르는 것이 중요하다 — 예전 지우개는 획 번호 하나였고 세션이
    // 정수인지만 보면 됐지만, 이제는 점 배열이 들어온다.
    if (msg.t === 'erase' || msg.t === 'doodleErase') {
      if (conn.strokeBudget-- <= 0) return;
      if (!Array.isArray(msg.path)) return;
      const [w, h] = msg.t === 'erase' ? [1000, 1000] : [DOODLE_W, DOODLE_H];
      const clean = msg.path
        .filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
        .map(([x, y]) => [clamp(Math.round(x), 0, w), clamp(Math.round(y), 0, h)] as Point);
      if (clean.length === 0) return;
      if (msg.t === 'erase') session.eraseInk(id, clean);
      else session.eraseDoodleInk(id, clean);
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
    notifyLobby();
  });

  socket.on('close', () => {
    conns.delete(conn);
    // 이미 다른 연결이 이 자리를 넘겨받았다면(빠른 새로고침) 이탈로 처리하지 않는다
    if (actors.get(conn.actorId) !== conn) return;
    actors.delete(conn.actorId);
    session.disconnect(conn.actorId);

    // 방을 여기서 지우지 않는다. 새로고침 한 번에 0명이 되는 순간이 있어서,
    // 그때 지우면 방 이름과 점수가 통째로 날아간다. 치우는 일은 sweepEmptyRooms가 맡는다.
    if (session.connectedCount === 0) emptyAt.set(room, Date.now());
    notifyLobby();
  });
});

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

console.log(
  existsSync(join(dist, 'index.html'))
    ? `PIZZART 서버가 http://localhost:${PORT} 에서 화면과 게임을 함께 냅니다`
    : `PIZZART 서버가 ws://localhost:${PORT} 에서 대기 중 (화면은 Vite가 맡습니다)`,
);
