import type { Point } from '../shared/drawing';
import { CANVAS, CENTER, RADIUS } from '../shared/drawing';
import { drawStrokes, fitCanvas } from './ink';

/**
 * 라운드 결과. 원본과 조각 경계, 내 조각이 어디였는지를 보여준다.
 * 라운드가 끝난 뒤에만 부른다 — 여기서 처음으로 원본과 섹터 번호를 받기 때문이다.
 */
export function revealRound(
  el: HTMLCanvasElement,
  drawing: Point[][],
  sliceCount: number,
  owners: Array<{ sliceIndex: number; playerId: string | null }>,
  youId: string,
): void {
  const ctx = el.getContext('2d')!;
  const scale = fitCanvas(el);
  const mine = owners.find((o) => o.playerId === youId)?.sliceIndex ?? -1;
  const step = (Math.PI * 2) / sliceCount;

  ctx.save();
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, CANVAS, CANVAS);

  ctx.beginPath();
  ctx.arc(CENTER[0], CENTER[1], RADIUS - 2, 0, Math.PI * 2);
  ctx.fillStyle = '#f6efe2';
  ctx.fill();

  drawStrokes(ctx, drawing);

  // 조각 경계. 내 조각만 강조한다.
  for (let i = 0; i < sliceCount; i++) {
    ctx.beginPath();
    ctx.moveTo(CENTER[0], CENTER[1]);
    ctx.arc(CENTER[0], CENTER[1], RADIUS - 2, i * step, (i + 1) * step);
    ctx.closePath();
    ctx.strokeStyle = i === mine ? '#e0803a' : '#d9c9a8';
    ctx.lineWidth = i === mine ? 6 : 2;
    ctx.stroke();
  }
  ctx.restore();
}
