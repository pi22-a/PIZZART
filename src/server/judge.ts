/**
 * 정확 일치. 동의어 목록도 오타 보정도 없다.
 *
 * 양끝 공백만 예외로 잘라낸다. 눈에 안 보이는 뒤 공백 하나로 틀리는 것은
 * 농담이 아니라 버그로 읽힌다.
 *
 * 나중에 합의제·선착순·대표 1인 모드를 붙일 때 이 파일에 전략을 추가한다.
 */
export function judge(answer: string, word: string): boolean {
  const a = answer.trim();
  if (a.length === 0) return false;
  return a === word.trim();
}
