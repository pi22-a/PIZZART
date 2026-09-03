import { Net } from './net';
import { CircleCanvas } from './canvas';
import type { Point } from '../shared/drawing';
import type { ChatLine, PlayerInfo, RoundRecap, ServerMsg } from '../shared/protocol';
import {
  show, setTag, renderPlayers, renderSlices, renderAnswers, renderRooms, setKickHandler,
  renderRanking, renderGallery,
  renderTopics,
  syncClock,
  renderWatch, countdown, stopSpinHint, renderLobbyNote, renderSkipTally, renderRoundDots, renderChat,
  renderCapacity,
  flashHost, toast, scrollChatToBottom,
} from './screens';
import { DoodleBoard, COLORS as DOODLE_COLORS } from './doodle';
import { PALETTE, PALETTE_NAMES, DEFAULT_COLOR } from '../shared/palette';
import { armAudio, isMuted, loadMuted, setMuted, timeTick } from './sound';
import { normalizeRoomCode } from '../shared/room';
import { revealRound, drawBoard, drawAssembled } from './reveal';
import { canSharePng, drawGalleryCard, shareCard } from './share';
import { keepAwake } from './wake';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * 브라우저에 남기는 값. 전부 이걸로 다룬다.
 *
 * localStorage는 사생활 보호 모드나 사이트 데이터 차단 설정에서 **읽기만 해도 예외를
 * 던진다.** 예전에는 테마만 raw로 읽었는데, 그 줄이 모듈 맨 위에 있어서 예외가 나면
 * 게임이 통째로 안 떴다. 기억은 편의지 게임의 조건이 아니다.
 */
const keep = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
};

/**
 * 밝게/어둡게.
 *
 * **고른 적이 없으면 기기 설정을 따라간다.** 폰을 밝은 모드로 쓰는 사람에게 어두운
 * 화면을 들이밀 이유가 없다. 한 번 누르면 그때부터는 고른 값이 이긴다 — 기기 설정과
 * 다르게 쓰고 싶은 사람의 뜻이 더 분명하기 때문이다.
 *
 * 피자 원판은 어느 쪽에서도 종이처럼 읽히므로 배경과 글자색만 바꾼다. 다만 밝은
 * 모드에서는 배경과 반죽이 거의 같은 크림색이라, 원판 테두리는 따로 진하게 한다
 * (canvas.ts, screens.ts).
 */
const THEME_KEY = 'pizzart-theme';
const themeBtn = $('themeBtn') as HTMLButtonElement;
/** 기기가 밝은 모드인가. 지원하지 않는 브라우저면 어두운 쪽으로 본다. */
const systemLight = () => window.matchMedia?.('(prefers-color-scheme: light)');

function applyTheme(light: boolean): void {
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  themeBtn.textContent = light ? '☀️' : '🌙';
  themeBtn.title = light ? '어둡게 보기' : '밝게 보기';
}

function wantLight(): boolean {
  const saved = keep.get(THEME_KEY);
  if (saved) return saved === 'light';
  return systemLight()?.matches === true;
}
applyTheme(wantLight());

themeBtn.addEventListener('click', () => {
  const light = document.documentElement.dataset.theme !== 'light';
  keep.set(THEME_KEY, light ? 'light' : 'dark');
  applyTheme(light);
});

// 아직 고른 적이 없는 사람은 기기 설정이 바뀌면 따라간다. 고른 뒤에는 안 흔들린다.
systemLight()?.addEventListener?.('change', (e) => {
  if (!keep.get(THEME_KEY)) applyTheme(e.matches);
});

const params = new URLSearchParams(location.search);
/**
 * 어느 방에 들어갈 것인가. 비어 있으면 로비다.
 *
 * 예전에는 비어 있으면 'LOBBY'라는 방으로 보냈다. 그래서 로비가 말만 로비지
 * 다른 방과 구별이 안 됐고, 링크를 줄 때마다 방 코드를 정해서 알려줘야 했다.
 */
const room = normalizeRoomCode(params.get('room') ?? '');
const inLobby = room === '';

/**
 * 같은 자리로 돌아오게 하는 식별자.
 *
 * sessionStorage에 두었더니 탭을 닫는 순간 사라져서, 다시 들어오면 새 사람이 되고
 * 점수가 0으로 시작했다. localStorage는 탭을 닫아도 남는다.
 *
 * 대가는 같은 브라우저의 모든 탭이 한 자리를 나눠 쓰게 되는 것이다.
 * 혼자 여러 창으로 시험할 때 곤란하므로 ?seat=2 처럼 이름을 붙이면 자리가 갈린다.
 */
/**
 * 자리를 가르는 이름. 혼자 여러 창으로 시험할 때 쓴다.
 *
 * 바깥에서는 안 먹힌다. 이게 열려 있으면 주소 한 글자로 새 자리를 만들 수 있어서,
 * 강퇴가 그 자리에서 무의미해진다.
 */
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const seat = isLocal ? (params.get('seat') ?? '') : '';
const CID_KEY = seat ? `pizzart-cid:${seat}` : 'pizzart-cid';
const NAME_KEY = seat ? `pizzart-name:${seat}` : 'pizzart-name';
/** 사생활 모드에서는 저장이 막힌다. 그렇다고 판이 멈추면 안 된다. */
let cid = keep.get(CID_KEY);
if (!cid) { cid = crypto.randomUUID(); keep.set(CID_KEY, cid); }

let youId = '';
let hostId = '';
let names = new Map<string, string>();
let sliceCount = 8;
let lastPhase = '';
/**
 * 직전에 알고 있던 방장. 방장이 나에게 넘어온 순간을 잡는 데만 쓴다.
 *
 * 빈 문자열로 시작하는 것이 중요하다 — 처음 들어와서 내가 방장이 되는 것은
 * "넘어온" 것이 아니고, 새로고침으로 돌아온 것도 마찬가지다. 둘 다 알릴 일이 아니다.
 */
let lastHostId = '';
let lastWatch = false;
let lastRound = -1;
let iSolved = false;
let lastAttempt = -1;
/** 회차가 넘어갔으니 입력칸에 커서를 돌려줘야 한다 — 화면 상태가 다 정해진 뒤에 쓴다. */
let refocusAfterRender = false;

/**
 * 회차가 넘어가면 커서가 풀려서 매번 입력칸을 다시 눌러야 했다.
 *
 * 비활성 여부가 room 처리 끝에서야 정해지므로, 회차 전환 시점에 바로 focus()를 부르면
 * 그 뒤 disabled 처리에 묻힌다. 그래서 표시만 해두고 여기서 준다.
 */
function restoreFocus(): void {
  if (!refocusAfterRender) return;
  // 아직 잠겨 있으면 표시를 남겨둔다. room이 조각(slices)보다 먼저 오므로 이 시점에는
  // 아직 조각을 못 받아 입력칸이 잠겨 있고, 여기서 표시를 지워버리면 영영 커서가 안 온다.
  if (answerInput.disabled || !$('s-guess').classList.contains('on')) return;
  refocusAfterRender = false;
  answerInput.focus();
}
let drawerId = '';
/** 이번 시도에 내 조각을 받았는가. 못 받았으면 이 라운드는 관전이다. */
let hasSlices = false;
/** 내가 관전자인가. 서버가 room으로 알려준다 — 로비에서 고르거나, 도중에 들어와서 박힌다. */
let iWatch = false;
/**
 * 이번 회차에 답을 냈는가.
 *
 * 두 가지에 쓴다. 회차가 넘어갈 때 낸 답을 지우는 데(안 낸 글자는 지키고 낸 답만 지운다),
 * 그리고 스킵을 잠그는 데. 스킵은 적어둔 답을 서버에서 지우므로, 낸 뒤에 누르면
 * 낸 답이 조용히 사라진다.
 */
let submittedThisAttempt = false;
/** 지난 회차에 낸 답. 입력칸에서 지우는 대신 여기로 옮겨 보여준다. */
let lastSubmitted = '';

/** 내 이름. 로비에서 정하고 방까지 들고 간다. */
let myName = keep.get(NAME_KEY) ?? params.get('name') ?? '';

const net = new Net(room, onMsg);

/** 방에 실제로 들어간다. 이름이 정해진 뒤에만 부른다. */
function joinRoom(): void {
  net.send({ t: 'join', name: myName, cid: cid! });
}

/**
 * 첫 화면을 정한다.
 *
 * 이름이 없으면 무조건 이름부터 묻는다 — 로비로 가든 방으로 가든 이름 없이는
 * 결과 화면이 '손님' 다섯 줄이 된다.
 */
function routeEntry(): void {
  if (!myName) { enterName.value = ''; show('enter'); return; }
  setTag('whoami', myName);
  if (inLobby) { show('rooms'); return; }
  // 소켓이 아직 안 열렸어도 된다. Net이 큐에 담았다가 열릴 때 보낸다.
  joinRoom();
}
// 붙어 있을 때는 아무 말도 안 한다. 늘 떠 있는 상태 표시는 신호가 될 수 없다 —
// "연결됨"이 항상 그 자리에 있으면 "끊김"으로 바뀌어도 눈에 안 들어온다.
net.onStatus((ok) => setTag('netTag', ok ? '' : '끊김 — 다시 붙는 중'));

/**
 * 다시 붙으면 서버에 나를 알린다. 같은 cid면 원래 자리에 앉고, 그 라운드에 받았던
 * 제시어·조각·현황판·이야기가 전부 다시 온다(session.restore).
 *
 * 로비에 서 있는 동안에는 join 할 방이 없다. 그때는 방 목록만 다시 달라고 한다.
 */
net.onReconnect(() => (inLobby ? { t: 'rooms' } : { t: 'join', name: myName, cid: cid! }));

const drawCanvas = new CircleCanvas($('drawCanvas') as HTMLCanvasElement, { interactive: true });
/**
 * 획은 다 그은 뒤에 통째로 보낸다.
 *
 * 예전에는 점이 찍힐 때마다 net에 넣고 50ms마다 모아 보냈다. 그 방식은 전원이 동시에
 * 그리며 서로의 선을 실시간으로 보던 이전 게임의 것이고, PIZZART는 출제자 혼자 그리며
 * 아무도 그 과정을 보지 않으므로 쪼개 보낼 이유가 없다.
 *
 * 게다가 쪼개면 실제로 망가졌다. 사람이 천천히 그으면 점 사이 간격이 50ms를 넘어
 * 점 하나짜리 메시지가 나가는데, 서버는 점이 둘 미만인 획을 버린다. 즉 또박또박 그린
 * 그림일수록 통째로 사라졌다.
 */
drawCanvas.onStroke((points: Point[], color: string) => net.send({ t: 'stroke', points, color }));

/**
 * 대기 화면 낙서판. 출제자가 그리는 동안 기다리는 사람들이 같이 갈긴다.
 * 내 id는 늦게 정해지므로(joined 메시지) 값이 아니라 함수로 넘긴다.
 */
const doodle = new DoodleBoard($('doodleCanvas') as HTMLCanvasElement, () => youId);
doodle.onStroke((points: Point[]) => net.send({ t: 'doodle', points, color: doodle.getColor() }));

/**
 * 그리는 캔버스의 색과 도구.
 *
 * 색을 고르는 순간 화면이 그 색으로 바뀌어야 한다 — 서버에 물어볼 것이 없다.
 * 색은 획에 실어 보내고, 서버는 팔레트에 있는 색인지만 확인한다.
 */
function paintDrawTool(): void {
  const erasing = drawCanvas.getTool() === 'eraser';
  $('eraserBtn').classList.toggle('on', erasing);
  $('eraserBtn').textContent = erasing ? '지우개 끄기' : '지우개';
  // 지우개를 쓰는 동안 색을 고르면 자연스럽게 펜으로 돌아온다.
  ($('drawCanvas') as HTMLCanvasElement).style.cursor = erasing ? 'cell' : 'crosshair';
}

(function buildDrawPalette(): void {
  const box = $('drawColors');
  PALETTE.forEach((c, i) => {
    const b = document.createElement('button');
    b.style.background = c;
    b.dataset.color = c;
    b.title = PALETTE_NAMES[i];
    b.setAttribute('aria-label', PALETTE_NAMES[i]);
    b.classList.toggle('on', c === DEFAULT_COLOR);
    b.addEventListener('click', () => {
      drawCanvas.setColor(c);
      drawCanvas.setTool('pen');
      paintDrawTool();
      for (const el of box.querySelectorAll('button')) el.classList.toggle('on', el === b);
    });
    box.appendChild(b);
  });
})();

$('eraserBtn').addEventListener('click', () => {
  drawCanvas.setTool(drawCanvas.getTool() === 'eraser' ? 'pen' : 'eraser');
  paintDrawTool();
});
drawCanvas.onErasePoint((p) => net.pushErase(p));
drawCanvas.onEraseEnd(() => net.endErase());

function paintDoodleTool(): void {
  const erasing = doodle.getTool() === 'eraser';
  $('doodleEraserBtn').classList.toggle('on', erasing);
  $('doodleEraserBtn').textContent = erasing ? '지우개 끄기' : '지우개';
}

$('doodleEraserBtn').addEventListener('click', () => {
  doodle.setTool(doodle.getTool() === 'eraser' ? 'pen' : 'eraser');
  paintDoodleTool();
});
doodle.onErasePoint((p) => net.pushDoodleErase(p));
doodle.onEraseEnd(() => net.endDoodleErase());

/**
 * 낙서 색 고르기.
 *
 * 18색 전부 고를 수 있다. 남이 쓰는 색이어도 된다 — 지우기는 색이 아니라 사람으로
 * 가르기 때문이다. 다만 **여기서 색은 "누가 그렸나"를 나르므로** 처음 배정만은
 * 서버가 서로 다르게 준다. 누가 무슨 색을 쓰는지는 툴팁으로 알려준다.
 */
function renderDoodleColors(players: PlayerInfo[]): void {
  const box = $('doodleColors');
  if (box.childElementCount === 0) {
    for (const c of DOODLE_COLORS) {
      const b = document.createElement('button');
      b.style.background = c;
      b.dataset.color = c;
      b.setAttribute('aria-label', PALETTE_NAMES[DOODLE_COLORS.indexOf(c)] ?? c);
      b.addEventListener('click', () => {
        net.send({ t: 'doodleColor', color: c });
        // 서버 응답을 기다리지 않는다. 고른 순간부터 그 색으로 그어져야 한다.
        doodle.setColor(c);
        doodle.setTool('pen');
        paintDoodleTool();
        for (const el of box.querySelectorAll('button')) el.classList.toggle('on', el === b);
      });
      box.appendChild(b);
    }
  }
  const mine = players.find((p) => p.id === youId)?.doodleColor ?? '';
  // 색은 겹쳐도 된다. 누가 쓰는지는 막으려고가 아니라 알려주려고 모은다 —
  // 굳이 남과 같은 색을 고르겠다면 그건 고른 사람 마음이다.
  const users = new Map<string, string[]>();
  for (const p of players) {
    if (!p.doodleColor || p.id === youId) continue;
    users.set(p.doodleColor, [...(users.get(p.doodleColor) ?? []), p.name]);
  }
  if (mine) doodle.setColor(mine);
  for (const el of box.querySelectorAll('button')) {
    const b = el as HTMLButtonElement;
    const c = b.dataset.color!;
    const others = users.get(c);
    b.classList.toggle('on', c === mine);
    b.disabled = false;
    b.title = others
      ? `${others.join(', ')} 님이 쓰는 색${c === mine ? ' (나도 이 색)' : ''}`
      : c === mine ? '내 색' : '이 색으로 바꾸기';
  }
}
// 자동재생 정책 때문에 사람이 한 번 누르기 전에는 소리가 안 난다. 첫 조작에서 깨운다.
armAudio();
const muteBtn = $('muteBtn') as HTMLButtonElement;
const paintMute = () => {
  muteBtn.textContent = isMuted() ? '🔇' : '🔊';
  muteBtn.title = isMuted() ? '초읽기 소리 켜기' : '초읽기 소리 끄기';
};
loadMuted();
paintMute();
muteBtn.addEventListener('click', () => { setMuted(!isMuted()); paintMute(); });

$('doodleClearBtn').addEventListener('click', () => {
  doodle.clearMine();
  net.send({ t: 'doodleClear' });
});

/*
 * 이름칸은 두 곳뿐이다: 로비로 들어올 때(enterName)와 방 안(renameBar).
 *
 * 예전에는 방 대기 화면에도 따로 있었다. 로비가 생기기 전에는 거기가 이름을 정하는
 * 유일한 자리였기 때문인데, 이제는 같은 일을 하는 칸이 셋이 되어 한 곳을 고칠 때
 * 나머지를 잊게 된다. 방 안의 것 하나로 합쳤다.
 */

/**
 * 한글은 조합이 끝나기 전에 엔터가 먼저 온다.
 *
 * 조합 중(isComposing)에 보내면 마지막 글자가 아직 확정되지 않은 상태로 나가고,
 * 그 뒤에 확정된 글자가 입력칸에 남는다. 채팅에서는 그 글자가 다음 엔터에 또 나가
 * "다리다리" 뒤에 "리"가 한 줄 더 붙었고, 답 입력칸에서는 "고양이"를 치고 엔터를
 * 눌렀는데 "고양"이 제출돼 오답으로 1점을 잃었다.
 */
const enterSent = (e: KeyboardEvent) => e.key === 'Enter' && !e.isComposing;

// ── 로비 ──
const ROOMS_NOTE = '아래에서 골라 들어가셔도 됩니다. 목록은 저절로 바뀝니다.';
const enterName = $('enterName') as HTMLInputElement;
const newRoomName = $('newRoomName') as HTMLInputElement;

/** 방으로 옮겨간다. 페이지를 새로 여는 편이 소켓을 갈아 끼우는 것보다 간단하고 튼튼하다. */
function goRoom(code: string): void {
  const q = new URLSearchParams({ room: code });
  if (seat) q.set('seat', seat);
  location.href = `${location.pathname}?${q}`;
}
function goLobby(): void {
  const q = new URLSearchParams();
  if (seat) q.set('seat', seat);
  location.href = q.toString() ? `${location.pathname}?${q}` : location.pathname;
}

const confirmName = () => {
  const raw = enterName.value.trim();
  if (!raw) { setTag('enterHint', '이름을 비워둘 수 없습니다'); return; }
  keep.set(NAME_KEY, raw);
  myName = raw;
  setTag('whoami', raw);
  // 방으로 가던 길이었으면 그대로 보내고, 아니면 방 목록을 보여준다.
  if (room) { joinRoom(); } else { show('rooms'); }
};
$('enterBtn').addEventListener('click', confirmName);
enterName.addEventListener('keydown', (e: KeyboardEvent) => { if (enterSent(e)) confirmName(); });

$('renameMeBtn').addEventListener('click', () => {
  enterName.value = myName;
  setTag('enterHint', '엔터를 쳐도 됩니다 · 최대 12자');
  show('enter');
});

/**
 * 방 목록 새로고침.
 *
 * 목록은 원래 저절로 온다 — 누가 방을 만들면 서버가 바로 밀어준다. 그런데 소켓이
 * 끊기면 그 길이 막히고, 화면에는 마지막에 받은 목록이 그대로 남아 있어서 멀쩡해 보인다.
 * 그래서 이 버튼은 두 가지를 한다: 붙어 있으면 다시 달라고 하고, 끊겼으면 페이지를 새로 연다.
 * 로비에는 잃을 상태가 없으므로(이름은 브라우저에 남는다) 새로 여는 것이 가장 확실하다.
 */
$('refreshRoomsBtn').addEventListener('click', () => {
  if (!net.open) { location.reload(); return; }
  net.send({ t: 'rooms' });
  // 목록이 그대로면 눌린 티가 안 난다. 잠깐이라도 뭐라도 말해준다.
  setTag('roomsNote', '목록을 다시 받았습니다.');
  setTimeout(() => setTag('roomsNote', ROOMS_NOTE), 1400);
});

/*
 * 바로 시작 — 이 화면에서 사람이 내려야 할 결정을 0으로 만든다.
 *
 * 서버가 기다리는 방에 넣거나 하나 만들어 주고, 어느 쪽이든 roomCreated로 방 코드가
 * 돌아온다. 받는 쪽 처리는 방 만들기와 똑같아서 따로 쓸 것이 없다.
 */
$('quickBtn').addEventListener('click', () => {
  const btn = $('quickBtn') as HTMLButtonElement;
  btn.disabled = true;
  setTag('quickNote', '자리를 찾는 중…');
  net.send({ t: 'quickJoin' });
  // 응답이 안 오면 버튼이 영영 잠긴다. 몇 초 뒤 되살린다.
  setTimeout(() => { btn.disabled = false; setTag('quickNote', QUICK_NOTE); }, 5000);
});
const QUICK_NOTE = '기다리는 방이 있으면 들어가고, 없으면 하나 만들어 드립니다.';

$('makeRoomBtn').addEventListener('click', () => {
  net.send({ t: 'createRoom', name: newRoomName.value.trim() || `${myName}의 방` });
});

// ── 방 안 ──
/** 방금 끝난 판의 그림들과 순위. 모아 보기 화면과 공유 그림이 같이 쓴다. */
let lastGame: { rounds: RoundRecap[]; ranking: Array<{ name: string; score: number }> } = {
  rounds: [],
  ranking: [],
};

/*
 * 무엇이 일어날지를 버튼에 그대로 적는다. 폰에서는 공유창이 뜨고 PC에서는 파일이
 * 내려오는데, 한쪽 글자만 적어두면 다른 쪽 사람은 매번 놀란다.
 */
const 공유가능 = canSharePng();
($('galleryShareBtn') as HTMLButtonElement).textContent = 공유가능 ? '공유하기' : '그림으로 저장';
$('galleryShareBtn').title = 공유가능
  ? '이 판의 그림을 전부 한 장으로 모아 공유합니다'
  : '이 판의 그림을 전부 한 장의 그림으로 모아 내려받습니다';

$('galleryShareBtn').addEventListener('click', async () => {
  if (lastGame.rounds.length === 0) return;
  const btn = $('galleryShareBtn') as HTMLButtonElement;
  btn.disabled = true;
  setTag('galleryNote', '만드는 중…');
  try {
    const canvas = $('shareCanvas') as HTMLCanvasElement;
    drawGalleryCard(canvas, lastGame.rounds, lastGame.ranking);
    setTag('galleryNote', await shareCard(canvas));
  } catch {
    // 어디서 막혔든 판은 계속 돈다. 공유는 게임의 조건이 아니다.
    setTag('galleryNote', '이 브라우저에서는 저장이 막혀 있습니다');
  } finally {
    btn.disabled = false;
  }
});

$('leaveBtn').addEventListener('click', goLobby);
$('copyLinkBtn').addEventListener('click', () => {
  const url = `${location.origin}${location.pathname}?room=${room}`;
  navigator.clipboard?.writeText(url).then(
    () => setTag('roomNameTag', '링크를 복사했습니다'),
    () => prompt('이 주소를 복사하세요', url),
  );
  setTimeout(paintRoomBar, 1500);
});
$('lockBtn').addEventListener('click', () => net.send({ t: 'setLock', on: !roomLocked }));

/**
 * 준비 버튼과 집계.
 *
 * 방장에게는 시작, 나머지에게는 준비를 같은 자리에 보인다. 옆에 몇 명이 준비했는지만
 * 숫자로 붙인다 — 이 자리에서 알아야 할 것은 "다 모였나" 하나뿐이다.
 */
let iReady = false;
/** 다 준비했는가. 시작 버튼을 잠그는 데 쓴다. */
let allReady = true;
$('readyBtn').addEventListener('click', () => net.send({ t: 'setReady', on: !iReady }));

function paintReady(inLobby: boolean, ready: number, of: number, players: PlayerInfo[]): void {
  const host = youId === hostId;
  const me = players.find((p) => p.id === youId);
  iReady = me?.ready === true;

  // 관전자는 안 그리고 안 맞히니 준비할 것이 없다.
  const 보인다 = inLobby && !host && me?.spectator !== true;
  $('readyBtn').style.display = 보인다 ? '' : 'none';
  $('startBtn').style.display = inLobby && (host || me?.spectator === true) ? '' : 'none';

  const btn = $('readyBtn') as HTMLButtonElement;
  btn.textContent = iReady ? '준비 취소' : '준비';
  btn.classList.toggle('on', iReady);

  allReady = ready >= of;

  const tag = $('readyCount');
  tag.textContent = inLobby && of > 0 ? `${ready}/${of}` : '';
  tag.classList.toggle('done', allReady && of > 0);
  tag.title = '준비한 사람 / 참여하는 사람 (관전자는 세지 않습니다)';

  // 잠긴 버튼만 덩그러니 두면 "왜 안 눌리지"로 끝난다. 무엇을 기다리는지 적어준다.
  const start = $('startBtn') as HTMLButtonElement;
  start.title = !host ? '방장만 시작할 수 있습니다'
    : allReady ? '' : `아직 준비하지 않은 사람이 있습니다 (${ready}/${of})`;
}

/**
 * 흑백판 / 컬러판.
 *
 * 서버가 진짜 규칙을 쥔다(addStroke에서 검정으로 눌러버린다). 여기서 하는 일은
 * **못 하게 막는 것이 아니라 헷갈리지 않게 하는 것**이다 — 흑백판인데 팔레트가 열려
 * 있으면 빨강을 골라 그어놓고 검게 나오는 것을 보게 된다.
 */
let colorMode: 'mono' | 'color' = 'mono';

$('colorModeBtn').addEventListener('click', () => {
  net.send({ t: 'setColorMode', mode: colorMode === 'mono' ? 'color' : 'mono' });
});

function paintColorMode(): void {
  const 컬러 = colorMode === 'color';
  const btn = $('colorModeBtn') as HTMLButtonElement;
  const label = $('colorModeLabel');
  label.textContent = 컬러 ? '컬러' : '흑백';
  // 켜진 것은 주황이다 — 주제 버튼도 지우개도 그렇다.
  btn.classList.toggle('on', 컬러);
  btn.disabled = youId !== hostId;
  btn.title = youId === hostId ? '눌러서 바꿉니다' : '방장만 바꿀 수 있습니다';
  $('colorModeNote').textContent = 컬러
    ? '18색으로 그립니다 — 조각만 봐도 좁혀져서 흑백보다 쉽습니다'
    : '검은색으로만 그립니다';

  // 흑백판에서는 팔레트를 아예 감춘다. 고를 수 없는 것을 보여줄 이유가 없다.
  $('drawColors').style.display = 컬러 ? '' : 'none';
  if (!컬러) drawCanvas.setColor(DEFAULT_COLOR);
}

let roomLocked = false;
let roomLabel = '';
function paintRoomBar(): void {
  setTag('roomNameTag', roomLabel);
  const btn = $('lockBtn') as HTMLButtonElement;
  btn.textContent = roomLocked ? '입장 잠김 — 풀기' : '입장 잠그기';
  btn.classList.toggle('on', roomLocked);
  btn.disabled = youId !== hostId;
  btn.title = youId === hostId ? '' : '방장만 바꿀 수 있습니다';
}

setKickHandler((playerId) => net.send({ t: 'kick', playerId }));

/** 관전 중에 무엇을 볼지. 출제자 그림이 기본이다 — 관전은 그걸 보러 온 것이다. */
let specView: 'draw' | 'doodle' = 'draw';
$('viewDrawBtn').addEventListener('click', () => { specView = 'draw'; paintSpecView(); });
$('viewDoodleBtn').addEventListener('click', () => { specView = 'doodle'; paintSpecView(); });

// 게임 도중에 들어온 사람만 쓰는 이름칸. 서버가 다시 확인한다.
const lateNameInput = $('lateNameInput') as HTMLInputElement;
const saveLateName = () => {
  const raw = lateNameInput.value.trim();
  if (!raw) return;
  keep.set(NAME_KEY, raw);
  net.send({ t: 'join', name: raw, cid: cid! });
  setTag('lateNameNote', '저장됐습니다');
};
$('lateNameBtn').addEventListener('click', saveLateName);
lateNameInput.addEventListener('keydown', (e: KeyboardEvent) => { if (enterSent(e)) saveLateName(); });

$('rerollBtn').addEventListener('click', () => net.send({ t: 'reroll' }));
/** 지금 방 정원과 그 한계. 스테퍼가 다음 값을 계산하는 데 쓴다. */
let capacityNow = 9;
let capacityFloor = 3;
let capacityCeil = 9;

/**
 * 스테퍼를 한 칸 옮긴다.
 *
 * 서버가 값을 돌려줄 때까지 기다리지 않고 먼저 옮긴다. 기다리면 연타가 통째로
 * 먹히지 않는다 — 응답이 오기 전의 클릭은 전부 같은 값을 보내게 되어, 여덟 번을
 * 눌러도 한 칸만 움직인다. 서버가 판정을 다시 하고 그 결과가 곧 화면을 덮으므로,
 * 여기서 앞서 나가도 어긋난 채로 남지 않는다.
 */
function stepCapacity(delta: number): void {
  const next = Math.min(capacityCeil, Math.max(capacityFloor, capacityNow + delta));
  if (next === capacityNow) return;
  capacityNow = next;
  setTag('capValue', `${next}명`);
  net.send({ t: 'setCapacity', max: next });
}
$('capMinusBtn').addEventListener('click', () => stepCapacity(-1));
$('capPlusBtn').addEventListener('click', () => stepCapacity(1));

$('startBtn').addEventListener('click', () => net.send({ t: 'start' }));
$('doneBtn').addEventListener('click', () => net.send({ t: 'drawDone' }));
$('undoBtn').addEventListener('click', () => net.send({ t: 'undo' }));
$('nextBtn').addEventListener('click', () => net.send({ t: 'next' }));
$('againBtn').addEventListener('click', () => net.send({ t: 'again' }));
// 스킵은 "이번 회차는 접는다"는 뜻이다. 적어둔 답을 밀어 보내지 않는다 —
// 스킵으로 점수를 지키려던 사람이 그 답으로 채점되면 안 된다.
// 서버도 같은 이유로 스킵한 사람의 답을 지운다.
$('skipBtn').addEventListener('click', () => net.send({ t: 'skip' }));

const answerInput = $('answerInput') as HTMLInputElement;
/**
 * 치는 것만으로는 제출되지 않는다. 제출은 버튼이나 엔터로만 한다.
 *
 * 예전에는 250ms마다 자동으로 보냈다. 그래서 "고양"까지 치다가 회차가 끝나면 그게
 * 오답 제출로 채점돼 1점이 깎였다 — 낼 생각도 없던 답이었는데.
 */
answerInput.addEventListener('input', () => {
  // 제출 뒤에 글자를 고치면 "제출됨" 표시가 지금 값과 어긋난 거짓말이 된다 — 바로 지운다.
  markAnswerSaved(false);
  markAnswerPending(answerInput.value.trim().length > 0);
});
// 엔터는 모두의 반사 신경이다. 여기서 안 받으면 아무 일도 안 일어난 것처럼 보인다.
// 제출 버튼과 똑같이 즉시 반영 + 확인 표시까지 간다.
answerInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (enterSent(e)) submitAnswer();
});
$('answerSubmitBtn').addEventListener('click', submitAnswer);

/**
 * 결과·최종 화면의 이야기. 한 판 내내 이어지는 하나의 로그를 두 화면이 같이 그린다.
 * 어느 화면에 있든 같은 내용이 보여야 해서 둘 다 매번 다시 그린다.
 */
let chatLines: ChatLine[] = [];
function paintChat(): void {
  renderChat('roundChatLog', chatLines);
  renderChat('finalChatLog', chatLines);
}

function wireChat(inputId: string, sendId: string): void {
  const box = $(inputId) as HTMLInputElement;
  const send = () => {
    const text = box.value.trim();
    if (text.length === 0) return;
    net.send({ t: 'chat', text });
    // 비우는 것이 곧 "나갔다"는 신호다. 남아 있으면 또 보낸 줄 알고 다시 누른다.
    box.value = '';
  };
  box.addEventListener('keydown', (e: KeyboardEvent) => { if (enterSent(e)) send(); });
  $(sendId).addEventListener('click', send);
}
wireChat('roundChatInput', 'roundChatSend');
wireChat('finalChatInput', 'finalChatSend');

// 관전 고르기. 로비에서만 먹힌다 — 서버가 다시 확인한다.
$('playBtn').addEventListener('click', () => net.send({ t: 'setSpectator', on: false }));
$('watchBtn').addEventListener('click', () => net.send({ t: 'setSpectator', on: true }));

/**
 * 제출 버튼과 엔터가 공유하는 경로. 무조건 보내고 "제출됨" 확인을 켠다 —
 * 답은 최종이 아니라 지금 서버에 저장된 값이라는 뜻이라, 다시 고치면 확인은 다시 꺼진다.
 */
function submitAnswer(): void {
  if (answerInput.disabled) return;
  net.send({ t: 'answer', text: answerInput.value });
  submittedThisAttempt = true;
  lastSubmitted = answerInput.value.trim();
  markAnswerSaved(true);
}

function markAnswerSaved(saved: boolean): void {
  if (saved) markAnswerPending(false);
  // 고쳐 낼 수 있다는 걸 알려야 한다. 모르면 입력칸을 열어둔 의미가 없다.
  $('answerSavedNote').textContent = saved ? '제출됨 ✓ — 고쳐서 다시 내도 됩니다' : '';
}

/**
 * 쓰기만 하고 아직 안 낸 상태를 알려준다.
 *
 * 자동 제출을 없앴으므로, 적어놓고 제출을 안 누르면 아무 일도 안 일어난다.
 * 그걸 모르면 "냈는데 왜 무응답이지?"가 된다.
 */
function markAnswerPending(pending: boolean): void {
  $('answerSavedNote').textContent = pending ? '아직 제출 안 함 — 엔터나 제출' : '';
}

/**
 * 조각을 못 받은 사람에게 살아 있는 척하는 입력창을 주지 않는다.
 * 라운드 도중 합류자와, 조각을 나눌 때 끊겨 있던 사람이 여기 해당한다.
 * 그대로 두면 열심히 답을 쳐 넣지만 서버는 조용히 버린다.
 */
/**
 * 답을 낼 수 없는 이유들. 잠금을 정하는 데 필요한 것을 여기 모아둔다.
 *
 * 예전에는 방 상태가 올 때 잠그고 조각이 올 때 푸는 식으로 두 군데서 각자 정했다.
 * 그런데 맞힌 사람도 회차마다 조각을 계속 받으므로(session.endAttempt), 조각이 오는
 * 순간 잠금이 통째로 풀렸다 — 맞혀놓고도 답을 또 낼 수 있었다.
 */
let iSkipped = false;
let iAnsweredNow = false;
let isFinalAttempt = false;

/**
 * 입력칸과 두 버튼의 잠금을 정한다. 이 함수 하나만 이 셋을 건드린다.
 * 두 군데서 각자 정하면 나중에 오는 쪽이 앞의 결정을 조용히 덮는다.
 */
function paintAnswerLock(): void {
  const spectating = !hasSlices;
  const mute = iSolved || iSkipped || spectating;
  answerInput.disabled = mute;
  ($('answerSubmitBtn') as HTMLButtonElement).disabled = mute;
  // 답을 냈으면 스킵을 잠근다. 서버의 skip()은 적어둔 답을 지우므로, 답을 내고 나서
  // 누르면 낸 답이 조용히 사라진다 — 맞는 답이었어도.
  ($('skipBtn') as HTMLButtonElement).disabled = mute || isFinalAttempt || iAnsweredNow;
  $('spectateNote').textContent = spectating
    ? '이번 라운드는 관전입니다 — 다음 라운드부터 참여합니다'
    : '';
}

function onMsg(m: ServerMsg): void {
  if (m.t === 'roomList') { renderRooms(m.rooms, goRoom); return; }
  if (m.t === 'roomCreated') { goRoom(m.room); return; }
  if (m.t === 'kicked') {
    // 방을 잃었다는 뜻이다. 빈 화면에 남겨두지 않고 로비로 돌려보낸다.
    // 다시 붙지 않는다 — 안 그러면 내보내진 사람이 자동으로 계속 문을 두드린다.
    net.stop();
    alert(m.msg);
    goLobby();
    return;
  }

  if (m.t === 'joined') { youId = m.youId; return; }

  if (m.t === 'room') {
    /*
     * 방장이 나에게 넘어왔다.
     *
     * 프로토콜에 새 메시지를 만들지 않는다 — room이 이미 hostId를 실어 보내므로
     * 바뀌었는지는 여기서 안다. 그래서 넘어오는 길이 몇 개든(방장이 관전을 켜거나,
     * 끊기거나) 알림은 한 자리에서만 처리된다.
     */
    const tookOver = lastHostId !== '' && lastHostId !== m.hostId && m.hostId === youId;
    lastHostId = m.hostId;
    if (tookOver) {
      flashHost(youId);
      // 무엇이 달라졌는지까지 적는다. "방장이 되었습니다"만으로는 뭘 해야 하는지 모른다.
      toast('👑 <b>방장이 되었습니다</b><br>이제 시작·다음 버튼을 누를 수 있습니다');
    }
    hostId = m.hostId;
    names = new Map(m.players.map((p) => [p.id, p.name]));
    syncClock(m.now);
    renderPlayers(m.players, youId, hostId, m.phase);
    // 색은 서버가 정하고 room으로 내려온다. 남이 색을 바꿔도 바로 팔레트에 반영돼야
    // "임자 있는 색"을 눌러보는 일이 없다.
    if (m.phase === 'drawing') renderDoodleColors(m.players);
    renderRoundDots(m.round, m.phase === 'lobby' ? 0 : m.totalRounds);
    // 주제는 상단이 아니라 조각 옆에 있다. 시선이 이미 가 있는 자리라야 읽힌다.
    setTag('guessTopic', m.topic ? `주제 : ${m.topic}` : '');
    // 그리는 화면에도 준다. 출제자도 관전자도 그동안 주제를 볼 데가 없었다.
    setTag('drawTopic', m.topic ? `주제 : ${m.topic}` : '');
    // 소리는 시간이 도는 단계에서만 낸다. 결과 화면처럼 마감이 없는 곳은 조용하다.
    const 그리는중 = m.phase === 'drawing';
    countdown(m.deadline, (left) => {
      if (m.phase === 'drawing' || m.phase === 'guessing') timeTick(left);
      // 그리는 동안에는 양쪽 화면에 같은 숫자를 적는다. 그리는 사람은 손을 서두를지,
      // 기다리는 사람은 낙서를 접을지 정하려면 둘 다 남은 시간을 알아야 한다.
      const 남음 = 그리는중 ? `${left}초` : '';
      setTag('drawTime', 남음);
      setTag('waitTime', 남음);
    });
    // 마감이 없는 단계(결과 화면 등)에서는 콜백이 아예 안 불린다. 지난 숫자가 남지 않게 지운다.
    if (!그리는중) { setTag('drawTime', ''); setTag('waitTime', ''); }

    const me = m.players.find((p) => p.id === youId);
    iSolved = me?.solved === true;
    iWatch = me?.spectator === true;
    const iDraw = me?.isDrawer === true;
    const drawer = m.players.find((p) => p.isDrawer);
    if (drawer) drawerId = drawer.id;

    // 라운드 번호가 바뀌면 지난 라운드의 답변 잔상을 지운다(Finding 2, 3).
    // 시도 사이에는 phase가 안 바뀌므로 라운드 번호를 트리거로 쓴다.
    if (m.round !== lastRound) {
      lastRound = m.round;
      lastSubmitted = '';
      submittedThisAttempt = false;
      answerInput.value = '';
      hasSlices = false;
      renderAnswers('lastAnswers', [], names);
    }

    // 회차가 바뀌었다. 쓰던 글자는 그대로 둔다 — 치는 도중에 회차가 넘어가면 글자가
    // 사라져 처음부터 다시 쳐야 했다. 이제 제출은 버튼·엔터로만 하므로 남겨둬도
    // 실수로 다시 나가지 않는다.
    if (m.attempt !== lastAttempt) {
      lastAttempt = m.attempt;
      // 낸 답은 지우고 쓰다 만 글자는 지킨다.
      //
      // 글자를 지키기로 한 것은 "낼 생각이 없던 글자를 뺏지 말자"는 뜻이었지 낸 답까지
      // 지키자는 것이 아니었다. 틀린 답이 그대로 남아 있으면 조각이 한 장 늘어난 화면에
      // 이미 틀린 답이 준비돼 있는 셈이라, 무심코 다시 내면 1점을 더 잃는다.
      if (submittedThisAttempt) answerInput.value = '';
      submittedThisAttempt = false;
      markAnswerSaved(false); // 지난 회차의 "제출됨"이 새 회차까지 이어지면 거짓말이다
      markAnswerPending(answerInput.value.trim().length > 0);
      hasSlices = false;
      // 커서는 여기서 주면 안 된다. 입력칸의 비활성 여부가 이 아래에서 정해지므로
      // 지금 focus()를 부르면 그 뒤 disabled 처리에 묻힌다. 표시만 해두고 끝에서 준다.
      refocusAfterRender = true;
    }

    colorMode = m.colorMode;
    paintColorMode();

    if (m.phase === 'lobby') {
      renderTopics(m.topics, m.selectedTopics, youId === hostId,
        (topics) => net.send({ t: 'setTopics', topics }));
      $('playBtn').classList.toggle('on', !iWatch);
      $('watchBtn').classList.toggle('on', iWatch);
      $('watchNote').textContent = iWatch
        ? '관전 중입니다 — 그리지도 맞히지도 않고 정답을 보면서 구경합니다'
        : '관전을 고르면 정답을 보면서 구경만 합니다. 시작 뒤에는 바꿀 수 없습니다';
    }
    /*
     * 같은 자리에 방장은 시작, 나머지는 준비.
     *
     * 누구에게나 "이제 내가 누를 차례"인 버튼이 거기 하나 있는 셈이라, 무엇을 해야
     * 하는지 설명할 것이 없다. 방장은 준비 버튼을 볼 일이 없다 — 시작을 누르는
     * 것이 곧 준비의 표시다.
     */
    paintReady(m.phase === 'lobby', m.ready, m.readyOf, m.players);
    ($('startBtn') as HTMLButtonElement).disabled = youId !== hostId || !allReady;
    ($('nextBtn') as HTMLButtonElement).disabled = youId !== hostId;
    ($('againBtn') as HTMLButtonElement).disabled = youId !== hostId;
    // 잠긴 버튼만 덩그러니 두면 "왜 안 눌리지"로 끝난다. 누가 눌러야 하는지 적어준다.
    $('againNote').textContent = youId === hostId
      ? ''
      : `${names.get(hostId) ?? '방장'} 님이 눌러야 새 판이 시작됩니다`;
    renderLobbyNote(m.players, youId, hostId, m.minPlayers);
    capacityNow = m.maxPlayers;
    capacityCeil = m.capacityMax;
    // 서버와 같은 바닥을 쓴다: 최소 인원과 지금 있는 사람 수 중 큰 쪽.
    capacityFloor = Math.max(m.minPlayers, m.players.filter((p) => p.connected).length);
    renderCapacity(m.players, youId, hostId, m.maxPlayers, m.minPlayers, m.capacityMax);

    roomLocked = m.locked;
    roomLabel = `${m.roomName || '방'} · ${m.roomCode}`;
    $('roomBar').style.display = '';
    paintRoomBar();

    // 관전 전환 줄은 그리는 동안에만 쓸모가 있다. 그때 말고는 볼 것이 하나뿐이다.
    $('watchBar').style.display = iWatch && m.phase === 'drawing' ? '' : 'none';

    // 도중에 들어온 사람에게만 이름칸을 준다. 원래 있던 사람이 중간에 이름을 갈면
    // 그때까지 쌓인 답 기록과 이야기가 누구 것인지 어긋난다.
    const canRename = me?.canRename === true;
    $('renameBar').style.display = canRename ? '' : 'none';
    if (canRename && document.activeElement !== lateNameInput && !lateNameInput.value) {
      lateNameInput.value = me?.name === '손님' ? '' : (me?.name ?? '');
      // 대기 중에는 누구나 고칠 수 있고, 게임 중에 뜬다면 도중에 들어온 사람이라는 뜻이다.
      setTag('lateNameNote', m.phase === 'lobby'
        ? ''
        : '새로 오셨네요 — 이름을 정해두면 결과 화면에서 알아보기 쉽습니다');
    }

    // 관전 여부가 바뀌면 화면도 다시 잡아야 한다. 로비에서 관전을 켜고 시작하면
    // phase만 보고는 s-guess로 갈 수 있다.
    if (m.phase !== lastPhase || iWatch !== lastWatch) {
      onPhase(m.phase, iDraw, m.players, m.topic);
    }
    lastPhase = m.phase;
    lastWatch = iWatch;

    // 판이 도는 동안에는 화면을 붙잡아 둔다. 기다리는 사람은 손을 안 대므로
    // 폰이 화면을 꺼버리고, 다시 켜면 회차가 넘어가 있다.
    keepAwake(m.phase !== 'lobby');

    if (m.phase === 'guessing') {
      const last = m.attempt >= m.maxAttempts;
      const skipped = me?.skipped === true;
      // 숫자만 적는다. "지금 맞히면"은 매 회차 같은 자리에서 반복되는 말이라,
      // 몇 번 보고 나면 읽히지 않으면서 줄만 길게 만든다. 바뀌는 것은 숫자뿐이다.
      $('scoreTag').textContent = iSolved
        ? '맞혔습니다 — 점수 확정'
        : `${me?.pendingScore ?? 0}점`;
      $('solvedWrap').style.display = iSolved ? '' : 'none';

      iSkipped = skipped;
      iAnsweredNow = me?.answered === true;
      isFinalAttempt = last;
      paintAnswerLock();

      const answered = iAnsweredNow;
      $('skipNote').style.display = iSolved || last || answered ? 'none' : '';
      // 잠긴 버튼만 덩그러니 두면 "왜 안 눌리지"가 된다. 끈 자리에 이유를 적는다.
      $('skipLocked').textContent = answered && !iSolved && !last
        ? '답을 냈습니다 · 회차가 끝나면 함께 공개됩니다'
        : '';
      $('prevAnswer').textContent = lastSubmitted && !iSolved
        ? `지난 회차에 낸 답: ${lastSubmitted}`
        : '';
      $('guessNote').textContent = last
        ? `시도 ${m.attempt}/${m.maxAttempts} — 마지막 기회입니다`
        : `시도 ${m.attempt}/${m.maxAttempts} — 다음 회차로 넘어가면 조각이 하나 늘고 1점 깎입니다`;
      renderSkipTally(m.players, youId);
    }
    restoreFocus();
    return;
  }

  if (m.t === 'word') {
    setTag('wordTag', m.word);
    // 남은 횟수를 버튼에 적는다. 몇 번 남았는지 모르면 아껴 쓸지 말지 정할 수 없다.
    const btn = $('rerollBtn') as HTMLButtonElement;
    btn.textContent = m.rerollsLeft > 0 ? `제시어 바꾸기 (${m.rerollsLeft})` : '제시어 바꾸기';
    btn.disabled = m.rerollsLeft <= 0;
    btn.title = m.rerollsLeft > 0
      ? '다른 제시어를 받습니다. 주제와 남은 시간은 그대로이고, 그리던 것은 지워집니다'
      : '더 바꿀 수 없습니다';
    return;
  }
  if (m.t === 'canvas') { drawCanvas.render(m.strokes); return; }

  if (m.t === 'doodleStroke') { doodle.add({ by: m.by, points: m.points, color: m.color }); return; }
  if (m.t === 'doodleBoard') { doodle.setBoard(m.strokes); return; }

  if (m.t === 'slices') {
    sliceCount = m.count;
    hasSlices = true;
    // 지난 라운드 마지막 회차에서 켜둔 조립판을 여기서 되돌린다. 되돌리지 않으면
    // 조각칸이 숨겨진 채로 다음 라운드에 들어가 지난 그림이 그대로 남는다 —
    // 조립판을 받은 적이 없는 직전 출제자만 새 그림을 보게 된다.
    $('sliceBox').style.display = '';
    $('assembledWrap').style.display = 'none';
    renderSlices(m.slices, sliceCount);
    // 조각이 도착해야 입력칸이 열린다. 다만 통째로 열지는 않는다 — 맞힌 사람도
    // 회차마다 조각을 계속 받으므로, 여기서 풀어버리면 맞혀놓고 또 답을 내게 된다.
    paintAnswerLock();
    restoreFocus();
    return;
  }

  if (m.t === 'chatLog') { chatLines = m.lines; paintChat(); return; }
  if (m.t === 'chat') { chatLines = [...chatLines, m.line]; paintChat(); return; }

  if (m.t === 'attemptResult') {
    renderAnswers('lastAnswers', m.answers, names);
    return;
  }

  if (m.t === 'board') {
    const left = m.watching.filter((w) => !w.solved).length;
    const note = left > 0
      ? `${left}명이 아직 맞히는 중입니다 — 각자 지금 보고 있는 조각입니다`
      : '모두 맞혔습니다';
    // 출제자는 대기 화면에서, 먼저 맞힌 사람은 추론 화면 안에서 같은 현황판을 본다.
    $('boardWrap').style.display = '';
    renderWatch($('boardWatch'), m.watching, m.sliceCount, names);
    $('boardNote').textContent = note;
    if (iSolved) {
      $('solvedWrap').style.display = '';
      renderWatch($('solvedWatch'), m.watching, m.sliceCount, names);
      $('solvedNote').textContent = note;
    }
    return;
  }

  if (m.t === 'assembled') {
    // 마지막 회차. 회전을 풀어 제자리에 끼운 조각을 보여준다.
    $('sliceBox').style.display = 'none';
    $('assembledWrap').style.display = '';
    drawAssembled($('assembledCanvas') as HTMLCanvasElement, m.pieces, m.sliceCount);
    return;
  }

  if (m.t === 'roundEnd') {
    sliceCount = m.sliceCount;
    setTag('revealWord', `정답: ${m.word}`);
    // 결과 화면의 핵심은 점수가 아니라 다들 뭐라고 답했는가다(Finding 3).
    // 출제자는 답을 낸 적이 없으니 (무응답)이 아니라 점수 변화만 보여준다.
    //
    // 답은 이 메시지에 실려 온 것만 쓴다. 예전엔 attemptResult로 채워둔 지역 맵을
    // 봤는데, 결과 화면에서 새로고침하면 그 맵이 비어 있어 나만 전원 (무응답)으로 보였다.
    const rows = new Map(m.answers.map((r) => [r.playerId, r]));
    renderAnswers('revealAnswers', m.scores.map((s) => {
      const deltaText = s.delta > 0 ? `+${s.delta}점` : `${s.delta}점`;
      const row = rows.get(s.playerId);
      const text = s.playerId === drawerId
        ? `출제 ${deltaText}`
        : row?.text
          ? `${row.text} (${deltaText})`
          : '(무응답)';
      return { playerId: s.playerId, text, correct: m.correct.includes(s.playerId) };
    }), names);
    revealRound($('revealCanvas') as HTMLCanvasElement, m.drawing, m.sliceCount);

    return;
  }

  if (m.t === 'final') {
    renderRanking(m.ranking);
    // 그림은 서버가 실어 보낸 것만 쓴다. 라운드마다 모아두면 도중에 들어왔거나
    // 새로고침한 사람만 텅 빈 화면을 보게 된다.
    lastGame = { rounds: m.rounds, ranking: m.ranking };
    renderGallery(m.rounds);
    setTag('galleryNote', '');
    return;
  }
  if (m.t === 'error') {
    // 이름이 막혔으면 알림창만 띄우고 끝낼 수 없다. 저장된 이름으로 자동 입장하는
    // 사람은 방에도 못 들어간 채 빈 화면에 갇힌다 — 고칠 수 있는 자리로 되돌린다.
    if (m.kind === 'name') {
      enterName.value = '';
      setTag('enterHint', m.msg);
      show('enter');
      return;
    }
    alert(m.msg);
    return;
  }
}

/**
 * 관전 중 보는 화면을 다시 잡는다. 전환 버튼과 onPhase가 같이 쓴다.
 *
 * 출제자 그림과 낙서판은 서로 다른 화면(s-draw / s-wait)에 있으므로,
 * 전환은 곧 화면을 갈아 끼우는 일이다.
 */
function paintSpecView(phase: string = lastPhase): void {
  $('viewDrawBtn').classList.toggle('on', specView === 'draw');
  $('viewDoodleBtn').classList.toggle('on', specView === 'doodle');
  // 단계를 인자로 받는다. onPhase가 부를 때는 lastPhase가 아직 이전 단계를 가리키고 있어서,
  // 그 값을 보면 관전 화면이 처음 뜨는 그 순간에만 아무 일도 안 일어난다.
  if (!iWatch || phase !== 'drawing') return;
  if (specView === 'draw') {
    $('doodleWrap').style.display = 'none';
    show('draw');
  } else {
    $('boardWrap').style.display = 'none';
    $('doodleWrap').style.display = '';
    show('wait');
  }
}

function onPhase(phase: string, iDraw: boolean, players: PlayerInfo[], topic: string): void {
  if (phase !== 'guessing') stopSpinHint();

  // 관전자는 출제자와 같은 것을 본다. 그리는 동안은 제시어와 그려지는 원본을,
  // 맞히는 동안은 남들이 무엇을 들고 헤매는지를. 화면은 출제자 것을 그대로 쓰고
  // 그릴 수 있는 것만 잠근다.
  const watching = $('drawCanvas').classList.contains('watching');
  if (iWatch && phase !== 'lobby' && phase !== 'roundEnd' && phase !== 'final') {
    $('doneBtn').style.display = 'none';
    $('undoBtn').style.display = 'none';
    $('rerollBtn').style.display = 'none';
    $('drawCanvas').classList.add('watching');
    $('doodleWrap').style.display = 'none';
    if (phase === 'drawing') {
      const drawer = players.find((p) => p.isDrawer);
      $('drawWatchNote').textContent = `관전 중 — ${drawer?.name ?? '누군가'} 님이 그리는 중입니다`;
      // 관전자는 낙서판을 볼 수는 있고 그리지는 못한다. 정답을 아는 사람이 그리면
      // 그게 곧 정답을 알려주는 짓이라 서버도 받지 않는다.
      $('doodleCanvas').classList.add('watching');
      return paintSpecView(phase);
    }
    $('waitTopic').textContent = topic ? `주제 : ${topic}` : '';
    $('waitWho').textContent = '관전 중 — 모두가 이 그림을 맞히는 중입니다';
    $('boardWrap').style.display = '';
    return show('wait');
  }
  if (watching) {
    // 관전을 껐다. 감춰둔 것을 되돌린다.
    $('doneBtn').style.display = '';
    $('undoBtn').style.display = '';
    $('rerollBtn').style.display = '';
    $('drawCanvas').classList.remove('watching');
    $('doodleCanvas').classList.remove('watching');
    $('drawWatchNote').textContent = '';
  }

  if (phase === 'lobby') return show('lobby');
  if (phase === 'drawing') {
    if (iDraw) {
      $('doodleWrap').style.display = 'none';
      drawCanvas.clear();
      return show('draw');
    }
    const drawer = players.find((p) => p.isDrawer);
    $('waitTopic').textContent = topic ? `주제 : ${topic}` : '';
    $('waitWho').textContent = `${drawer?.name ?? '누군가'} 님이 그리는 중입니다`;
    $('boardWrap').style.display = 'none';
    // 판을 먼저 띄우고 나서 비운다. 반대로 하면 아직 숨겨진 캔버스에 그려
    // 폭 0으로 뭉개지고, 그 뒤로 아무도 다시 그려주지 않아 빈 판이 된다.
    $('doodleWrap').style.display = '';
    show('wait');
    // 라운드가 바뀌면 낙서판도 새 판이다. 서버도 라운드 시작에서 비운다.
    doodle.clear();
    return;
  }
  if (phase === 'guessing') {
    $('doodleWrap').style.display = 'none';
    if (iDraw) {
      $('waitTopic').textContent = topic ? `주제 : ${topic}` : '';
      $('waitWho').textContent = '모두가 당신의 그림을 맞히는 중입니다';
      $('boardWrap').style.display = '';
      return show('wait');
    }
    return show('guess');
  }
  // 붙이기는 화면을 띄운 뒤에 한다. 숨겨진 동안에는 높이가 0이라 아무 데도 못 붙인다.
  if (phase === 'roundEnd') { show('round'); return scrollChatToBottom('roundChatLog'); }
  if (phase === 'final') { show('final'); return scrollChatToBottom('finalChatLog'); }
}

// 배선이 전부 끝난 뒤에 첫 화면을 정한다. 위에서 부르면 아직 없는 요소를 만지게 된다.
routeEntry();
