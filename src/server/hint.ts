export interface HintPlan {
  /** 전원에게 공개할 조각. 줄 것이 없으면 null */
  publicSlice: number | null;
  /** 숨은 조각이 떨어졌을 때의 폴백. 사람마다 다른 조각을 받는다 */
  perPlayer: Array<{ playerId: string; sliceIndex: number }>;
}

/**
 * 시도에 실패할 때마다 힌트를 하나 고른다.
 *
 * 1. 아직 아무도 못 본 조각이 남아 있으면 하나를 전원에게 공개한다. 기본 경로다.
 * 2. 다 떨어졌으면 각자에게 남이 이미 가진 조각을 하나씩 준다.
 *
 * 2번은 대화를 죽일 수 있다 — 혼자 두 조각을 보면 남에게 물을 이유가 준다.
 * 다만 그 시점엔 이미 그림 100%가 방에 흩어져 있고 두 번이나 못 맞힌 상태다.
 * "판이 멈추는 것이 최악"이 이긴다.
 */
export function planHint(
  hidden: number[],
  seenBy: Map<string, Set<number>>,
  allSlices: number[],
  pick: (n: number) => number,
): HintPlan {
  if (hidden.length > 0) {
    return { publicSlice: hidden[pick(hidden.length)], perPlayer: [] };
  }

  const perPlayer: Array<{ playerId: string; sliceIndex: number }> = [];
  for (const [playerId, seen] of seenBy) {
    const candidates = allSlices.filter((i) => !seen.has(i));
    if (candidates.length === 0) continue; // 줄 것이 없으면 그냥 넘어간다
    perPlayer.push({ playerId, sliceIndex: candidates[pick(candidates.length)] });
  }
  return { publicSlice: null, perPlayer };
}
