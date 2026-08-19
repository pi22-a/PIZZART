/**
 * 시간이 줄어드는 것을 소리로 알린다.
 *
 * 음원 파일을 두지 않는다 — 짧은 삐 소리 몇 개를 위해 저장소에 바이너리를 들이면
 * 용량도 늘고 저작권도 따져야 한다. Web Audio로 그 자리에서 만들면 둘 다 없다.
 *
 * 브라우저는 사람이 한 번 누르기 전에는 소리를 막는다(자동재생 정책). 그래서
 * 첫 클릭·키 입력에서 오디오를 깨우고, 그전에는 조용히 아무 일도 하지 않는다.
 */
type Ctor = typeof AudioContext;

let ctx: AudioContext | null = null;
let muted = false;

const KEY = 'pizza-muted';

/** 테스트 환경(jsdom)에는 AudioContext가 없다. 없으면 이 모듈은 통째로 무음이다. */
function audioCtor(): Ctor | null {
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function loadMuted(): boolean {
  try { muted = localStorage.getItem(KEY) === '1'; } catch { muted = false; }
  return muted;
}

export function isMuted(): boolean { return muted; }

export function setMuted(v: boolean): void {
  muted = v;
  try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* 사생활 모드 등 — 소리 설정 하나로 판을 멈추지 않는다 */ }
}

/**
 * 사람이 화면을 처음 건드릴 때 오디오를 깨운다.
 * 한 번만 걸면 되고, 실패해도 조용히 넘어간다 — 소리는 게임의 곁가지다.
 */
export function armAudio(): void {
  const start = () => {
    const Ctor = audioCtor();
    if (!Ctor) return;
    if (!ctx) ctx = new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();
  };
  document.addEventListener('pointerdown', start);
  document.addEventListener('keydown', start);
}

/** 짧은 삐 하나. 소리를 겹쳐도 서로 끊지 않도록 매번 새 노드를 쓴다. */
function beep(freq: number, ms: number, gain: number): void {
  if (muted) return;
  const Ctor = audioCtor();
  if (!Ctor) return;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === 'suspended') return;   // 아직 안 깨어났다 — 조용히 넘어간다

  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  // 뚝 끊으면 딸깍 소리가 난다. 짧게 올렸다 부드럽게 내린다.
  amp.gain.setValueAtTime(0, t0);
  amp.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
  osc.connect(amp).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + ms / 1000 + 0.02);
}

/**
 * 남은 시간에 맞춰 소리를 낸다. 매 초 울리면 시끄럽기만 해서 끝자락에만 낸다.
 *
 * 10초는 "슬슬 정해라", 5~1초는 점점 높아지는 초읽기, 0초는 끝났다는 신호다.
 */
export function timeTick(left: number): void {
  if (left === 10) beep(660, 70, 0.05);
  else if (left >= 1 && left <= 5) beep(880 + (5 - left) * 90, 70, 0.06);
  else if (left === 0) { beep(560, 130, 0.07); setTimeout(() => beep(420, 200, 0.07), 130); }
}
