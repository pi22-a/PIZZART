import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 욕설 거르기.
 *
 * 채팅은 **가린다**(별표). 이름과 방 제목은 **거부한다** — 채팅 한 줄은 흘러가지만
 * 이름은 판이 끝날 때까지 결과 화면과 이야기판에 계속 남는다. 남의 화면에 오래
 * 머무는 글자일수록 문을 좁게 잡는다.
 *
 * 라이브러리를 쓰지 않은 이유는 실제로 돌려보고 정했다. 오탐이 이 게임에서는 특히
 * 비싸다 — 그림을 설명해서 맞히는 게임이라 대화가 곧 게임인데, 널리 쓰이는 라이브러리
 * 하나는 "강아지 새끼 그린거야"를 욕설로, 다른 하나는 정상 낱말 "시발점"을 별표로
 * 만들었다. 목록과 예외를 우리가 쥐고 있어야 그런 자리를 그때그때 풀 수 있다.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Badwords {
  words: string[];
  allow: string[];
}

/**
 * 비교용으로 글자를 줄인다.
 *
 * 사람은 `시1발`, `시^발`, `시 발`처럼 사이에 무언가를 끼워 넣어 피한다. 그래서
 * 한글·자모·영문만 남기고 나머지(숫자·기호·공백·이모지)는 통째로 버린다. 버린 자리를
 * 기억해 두어야 원문에서 어디를 가릴지 알 수 있으므로, 남긴 글자마다 원래 위치를 함께 든다.
 */
function normalize(text: string): { norm: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!/[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z]/.test(c)) continue;
    chars.push(c.toUpperCase());
    map.push(i);
  }
  return { norm: chars.join(''), map };
}

let cached: { words: string[]; allow: string[] } | null = null;

function list(): { words: string[]; allow: string[] } {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(join(root, 'content', 'badwords.json'), 'utf8')) as Badwords;
  const clean = (xs: string[]) => xs.map((w) => normalize(w).norm).filter((w) => w.length > 0);
  // 긴 것부터 본다. `개새끼`가 `씨발`보다 먼저 걸리든 말든 결과는 같지만,
  // 예외 판정에서는 긴 쪽이 먼저 잡혀야 `시발점`이 `시발`을 덮을 수 있다.
  const byLength = (a: string, b: string) => b.length - a.length;
  cached = { words: clean(raw.words).sort(byLength), allow: clean(raw.allow).sort(byLength) };
  return cached;
}

/** 문자열 안에서 낱말이 나타나는 구간 전부 */
function spans(hay: string, needles: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const w of needles) {
    for (let from = 0; ; ) {
      const i = hay.indexOf(w, from);
      if (i < 0) break;
      out.push([i, i + w.length - 1]);
      from = i + 1;
    }
  }
  return out;
}

/** 원문에서 가려야 할 구간. 예외 낱말에 통째로 덮인 것은 뺀다. */
function hits(text: string): Array<[number, number]> {
  const { norm, map } = normalize(text);
  if (!norm) return [];
  const { words, allow } = list();
  const safe = spans(norm, allow);

  const found: Array<[number, number]> = [];
  for (const [i, j] of spans(norm, words)) {
    // `시발점`처럼 정상 낱말 안에 들어앉은 것은 욕이 아니다.
    if (safe.some(([a, b]) => a <= i && j <= b)) continue;
    found.push([map[i], map[j]]);
  }
  return found;
}

/** 욕설이 들어 있는가. 이름·방 제목을 거부할 때 쓴다. */
export function hasProfanity(text: string): boolean {
  return hits(text).length > 0;
}

/**
 * 욕설을 별표로 가린다. 걸린 글자 수만큼 가리되, 사이에 끼워 넣은 기호까지 함께 덮는다 —
 * `시1발`을 `*1*`로 두면 무슨 말이었는지 그대로 읽힌다.
 */
export function maskProfanity(text: string): string {
  const found = hits(text);
  if (found.length === 0) return text;
  const out = [...text];
  for (const [a, b] of found) {
    for (let i = a; i <= b; i++) out[i] = '*';
  }
  return out.join('');
}
