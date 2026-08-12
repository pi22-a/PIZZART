import { describe, it, expect } from 'vitest';
import { loadRules, loadTopics, pickWord } from '../src/server/content';

describe('loadRules', () => {
  it('숫자 손잡이를 파일에서 읽는다', () => {
    const r = loadRules();
    expect(r.minPlayers).toBe(4);
    expect(r.maxPlayers).toBe(9);
    expect(r.sliceCountMin).toBe(8);
    // maxAttempts와 attemptPoints는 플레이테스트 중 돌리는 손잡이다.
    // 특정 값을 못박으면 숫자를 조정할 때마다 테스트가 빨개진다. 관계만 검사한다.
    expect(r.maxAttempts).toBeGreaterThanOrEqual(1);
    expect(r.attemptPoints.length).toBe(r.maxAttempts);
    // 늦게 맞힐수록 낮아야 한다
    for (let i = 1; i < r.attemptPoints.length; i++) {
      expect(r.attemptPoints[i]).toBeLessThan(r.attemptPoints[i - 1]);
    }
  });

  it('시도 횟수만큼 점수 표가 있다', () => {
    const r = loadRules();
    expect(r.attemptPoints.length).toBe(r.maxAttempts);
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
      expect(t.words.length).toBeGreaterThanOrEqual(20);
      expect(new Set(t.words).size).toBe(t.words.length);
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
