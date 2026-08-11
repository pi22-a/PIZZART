import type { Point } from '../shared/drawing';
import { CANVAS } from '../shared/drawing';

/** 잉크는 어디서 그리든 같은 굵기·같은 색이다. */
export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Point[][]): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#2b2118';
  for (const s of strokes) {
    if (s.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(s[0][0], s[0][1]);
    for (let i = 1; i < s.length; i++) ctx.lineTo(s[i][0], s[i][1]);
    ctx.stroke();
  }
}

/**
 * 캔버스 픽셀 크기를 화면 크기와 dpr에 맞추고, 0~1000 좌표계로 그리기 위한 배율을 돌려준다.
 *
 * CSS에서 `aspect-ratio:1`로 정사각형을 잡아두므로 짧은 변을 기준으로 한다.
 * 이걸 안 하면 고해상도 화면에서 그림이 두 배로 늘어난다.
 */
export function fitCanvas(el: HTMLCanvasElement): number {
  const dpr = window.devicePixelRatio || 1;
  const size = Math.max(1, Math.min(el.clientWidth, el.clientHeight));
  const px = Math.round(size * dpr);
  if (el.width !== px) {
    el.width = px;
    el.height = px;
  }
  return el.width / CANVAS;
}
