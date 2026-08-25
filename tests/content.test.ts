import { describe, it, expect } from 'vitest';
import { loadRules, loadTopics, pickWord } from '../src/server/content';

describe('loadRules', () => {
  it('숫자 손잡이를 파일에서 읽는다', () => {
    const r = loadRules();
    expect(r.minPlayers).toBe(4);
    expect(r.maxPlayers).toBe(9);
    expect(r.sliceCountMin).toBe(8);
    expect(r.maxAttempts).toBeGreaterThanOrEqual(2);
    // 마지막 회차는 조립판이므로 조각 상한보다 하나 많아야 한다
    expect(r.maxAttempts).toBe(r.maxSlices + 1);
    expect(r.startScore).toBeGreaterThan(0);
    expect(r.finalAttemptScore).toBeGreaterThan(0);
    expect(r.drawerScore).toBeGreaterThan(0);
  });

  it('제시어 바꾸기 횟수가 있다', () => {
    expect(loadRules().wordRerolls).toBeGreaterThanOrEqual(0);
  });
});

describe('loadTopics', () => {
  it('주제를 전부 읽는다', () => {
    const topics = loadTopics();
    expect(topics.length).toBeGreaterThanOrEqual(3);
    expect(topics.map((t) => t.topic)).toContain('동물');
  });

  it('주제마다 단어가 넉넉히 있다', () => {
    for (const t of loadTopics()) {
      expect(t.words.length).toBeGreaterThanOrEqual(50);
      expect(new Set(t.words).size).toBe(t.words.length);
    }
  });

  it('같은 단어가 두 주제에 들어가 있지 않다', () => {
    // 들어가면 그 단어의 주제가 뽑을 때마다 달라진다. 맞히는 사람에게 주제는 힌트이므로
    // 같은 그림에 다른 힌트가 붙는 셈이 된다.
    const seen = new Map<string, string>();
    for (const t of loadTopics()) {
      for (const w of t.words) {
        expect(seen.has(w), `'${w}'가 ${seen.get(w)}와 ${t.topic}에 함께 있다`).toBe(false);
        seen.set(w, t.topic);
      }
    }
  });

  it('한 판을 다 돌고도 남을 만큼 있다', () => {
    // 테스터들이 50판 가까이 돌면서 제시어를 바닥냈다. 9라운드 × 여러 판을 버텨야 한다.
    const total = loadTopics().reduce((n, t) => n + t.words.length, 0);
    expect(total).toBeGreaterThanOrEqual(400);
  });

  it('주제 이름에 번호나 파일 냄새가 묻어 있지 않다', () => {
    // 파일 이름 앞의 번호는 읽는 순서를 정하려고 붙인 것이지 화면에 나갈 것이 아니다.
    for (const t of loadTopics()) {
      expect(t.topic).toMatch(/^[가-힣]+$/);
    }
  });
});

describe('pickWord', () => {
  it('주제와 제시어를 함께 낸다', () => {
    const topics = [{ topic: '동물', words: ['호랑이', '펭귄'] }];
    expect(pickWord(topics, () => 0)).toEqual({ topic: '동물', word: '호랑이' });
    expect(pickWord(topics, (n) => n - 1)).toEqual({ topic: '동물', word: '펭귄' });
  });
});
