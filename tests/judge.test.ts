import { describe, it, expect } from 'vitest';
import { judge } from '../src/server/judge';

describe('judge', () => {
  it('글자가 똑같으면 맞다', () => {
    expect(judge('호랑이', '호랑이')).toBe(true);
  });

  it('오타는 틀린 것이다 — 그것도 재미에 들어간다', () => {
    expect(judge('호랑치', '호랑이')).toBe(false);
  });

  it('동의어도 틀린 것이다', () => {
    expect(judge('범', '호랑이')).toBe(false);
    expect(judge('타이거', '호랑이')).toBe(false);
  });

  it('양끝 공백은 잘라낸다 — 안 보이는 공백으로 틀리면 농담이 아니라 버그다', () => {
    expect(judge('  호랑이 ', '호랑이')).toBe(true);
    expect(judge('호랑이\n', '호랑이')).toBe(true);
  });

  it('가운데 공백은 그대로 본다', () => {
    expect(judge('호 랑이', '호랑이')).toBe(false);
  });

  it('빈 답은 틀린 것이다', () => {
    expect(judge('', '호랑이')).toBe(false);
    expect(judge('   ', '호랑이')).toBe(false);
  });
});
