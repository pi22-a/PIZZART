import { describe, it, expect } from 'vitest';
import { normalizeRoomCode, ROOM_CODE_MAX } from '../src/shared/room';

/**
 * 주소창의 ?room= 은 아무나 아무 글자나 넣는 자리다. 실제로 친구가 60자짜리를 넣고
 * 들어와 상단 줄이 세 줄로 부풀었다. 그 자리를 여기서 막는다.
 */
describe('방 코드 손질', () => {
  it('너무 긴 코드는 자른다', () => {
    const long = '6482882828282828828KKKKKKKKKKDKSKDKDKDKKDK가나다라282I2882K2';
    const code = normalizeRoomCode(long);
    expect(code.length).toBe(ROOM_CODE_MAX);
    expect(long.toUpperCase().startsWith(code)).toBe(true);
  });

  it('같은 긴 코드를 넣은 두 사람은 같은 방으로 간다', () => {
    // 자르는 규칙이 결정적이어야 한다. 아니면 링크를 받은 사람만 다른 방에 떨어진다.
    const long = 'A'.repeat(40) + '뒤쪽';
    expect(normalizeRoomCode(long)).toBe(normalizeRoomCode(long));
  });

  it('소문자는 대문자로 — 같은 방을 두 개로 쪼개지 않는다', () => {
    expect(normalizeRoomCode('pizza')).toBe('PIZZA');
  });

  it('한글 코드는 그대로 쓴다 — 이 게임이 권해온 사용법이다', () => {
    expect(normalizeRoomCode('피자')).toBe('피자');
  });

  it('공백과 줄바꿈은 걷어낸다', () => {
    expect(normalizeRoomCode('  AB CD\n')).toBe('ABCD');
    expect(normalizeRoomCode('A\tB')).toBe('AB');
  });

  it('눈에 안 보이는 글자도 걷어낸다 — 코드가 같아 보이는데 다른 방이 된다', () => {
    expect(normalizeRoomCode('AB\u200bCD')).toBe('ABCD');
    expect(normalizeRoomCode('\ufeffAB')).toBe('AB');
  });

  it('보이지 않는 글자만으로는 방이 만들어지지 않는다 — 빈 값은 로비다', () => {
    expect(normalizeRoomCode('   ')).toBe('');
    expect(normalizeRoomCode('\u200b\u200b')).toBe('');
  });

  it('걷어낸 뒤에 자른다 — 공백이 자리를 차지하면 안 된다', () => {
    // 앞에 공백 열 개가 있어도 실제 글자 12개가 남아야 한다
    expect(normalizeRoomCode(' '.repeat(10) + 'ABCDEFGHIJKL')).toBe('ABCDEFGHIJKL');
  });

  it('빈 값과 잘못된 값에도 죽지 않는다', () => {
    expect(normalizeRoomCode('')).toBe('');
    expect(normalizeRoomCode(undefined as unknown as string)).toBe('');
    expect(normalizeRoomCode(null as unknown as string)).toBe('');
  });
});
