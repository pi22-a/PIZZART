import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Rules {
  minPlayers: number;
  maxPlayers: number;
  sliceCountMin: number;
  drawSeconds: number;
  guessSeconds: number;
  /** 마지막 회차는 조각을 제자리에 끼워 보여주는 조립판이다. */
  maxAttempts: number;
  /** 한 사람이 가질 수 있는 조각 수의 상한. 처음 1장 + 힌트 4번. */
  maxSlices: number;
  /** 아무것도 안 쓰고 첫 회차에 맞히면 받는 점수 */
  startScore: number;
  /** 틀린 제출 한 번의 대가. 맞힌 제출은 공짜다 */
  wrongSubmitCost: number;
  /** 힌트 한 번의 대가 */
  hintCost: number;
  /** 조립판(마지막 회차)에서 맞히면 주는 고정 점수 */
  finalAttemptScore: number;
  /** 0이면 자동으로 안 넘어간다 — 방장이 직접 눌러야 한다 */
  roundEndSeconds: number;
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
