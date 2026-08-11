import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Rules {
  minPlayers: number;
  maxPlayers: number;
  sliceCountMin: number;
  drawSeconds: number;
  guessSeconds: number;
  /** 결과 화면이 스스로 다음 라운드로 넘어가기까지. 방장이 화면을 잠가도 방이 멈추지 않게 한다. */
  roundEndSeconds: number;
  maxAttempts: number;
  attemptPoints: number[];
  drawerPointPerCorrect: number;
}

export interface Topic {
  topic: string;
  words: string[];
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadRules(): Rules {
  return JSON.parse(readFileSync(join(root, 'content', 'rules.json'), 'utf8')) as Rules;
}

export function loadTopics(): Topic[] {
  const dir = join(root, 'content', 'words');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Topic);
}

/**
 * 주제 하나를 고르고 그 안에서 단어 하나를 고른다.
 * 무작위를 밖에서 주입해 테스트에서 고정할 수 있게 한다.
 *
 * 나중에 출제자가 직접 타이핑하는 버전을 붙일 때 이 함수 자리에 꽂는다.
 */
export function pickWord(topics: Topic[], pick: (n: number) => number): { topic: string; word: string } {
  const t = topics[pick(topics.length)];
  return { topic: t.topic, word: t.words[pick(t.words.length)] };
}
