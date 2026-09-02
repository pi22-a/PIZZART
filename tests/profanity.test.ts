import { describe, it, expect } from 'vitest';
import { hasProfanity, maskProfanity } from '../src/server/profanity';

/**
 * 이 게임에서 오탐은 특히 비싸다. 그림을 설명해서 맞히는 게임이라 대화가 곧 게임이고,
 * 주제에 동물이 있어서 "강아지 새끼" 같은 말이 정상적으로 오간다. 그래서 "잡는다"만큼
 * **"엉뚱한 것을 안 잡는다"** 를 같은 무게로 확인한다.
 */
describe('욕설 가리기', () => {
  it('욕설을 별표로 덮는다', () => {
    expect(maskProfanity('야 이 개새끼야')).toBe('야 이 ***야');
    expect(maskProfanity('병신 같네')).toBe('** 같네');
  });

  it('사이에 끼워 넣은 기호까지 함께 덮는다 — 남겨두면 그대로 읽힌다', () => {
    expect(maskProfanity('시1발')).toBe('***');
    expect(maskProfanity('시^발')).toBe('***');
    expect(maskProfanity('시 발')).toBe('***');
  });

  it('초성만 써도 잡는다', () => {
    expect(maskProfanity('ㅅㅂ 진짜')).toBe('** 진짜');
    expect(maskProfanity('ㅄ아')).toBe('*아');   // ㅄ은 한 글자다
  });

  it('영어 욕도 잡는다', () => {
    expect(maskProfanity('oh fuck')).toBe('oh ****');
    expect(maskProfanity('SHIT')).toBe('****');
  });

  it('멀쩡한 말은 건드리지 않는다', () => {
    for (const s of [
      '고양이 새끼 그린거야', '강아지 새끼야', '새끼 손가락',
      '시발점에서 출발했다', '개나리 그린 것 같은데', '개똥벌레', '개구리',
      '보지 못했어', '자지 않고 그렸어', '등신대 크기',
      '안녕하세요', '피자 맛있겠다',
    ]) {
      expect(maskProfanity(s), s).toBe(s);
      expect(hasProfanity(s), s).toBe(false);
    }
  });

  it('이름·방 제목 판정은 있으면 참이다', () => {
    expect(hasProfanity('씨발러')).toBe(true);
    expect(hasProfanity('개새끼')).toBe(true);
    expect(hasProfanity('피자왕')).toBe(false);
    expect(hasProfanity('')).toBe(false);
  });

  it('빈 값과 기호만 있는 값에도 죽지 않는다', () => {
    expect(maskProfanity('')).toBe('');
    expect(maskProfanity('!!!???')).toBe('!!!???');
    expect(hasProfanity('   ')).toBe(false);
  });

  it('한 줄에 여러 번 나와도 전부 덮는다', () => {
    expect(maskProfanity('시발 진짜 병신')).toBe('** 진짜 **');
  });
});
