import type { Point } from '../shared/drawing';
import { CANVAS, CENTER, RADIUS } from '../shared/drawing';
import { slice } from '../shared/slicer';
import { drawStrokes, fitCanvas } from './ink';

const DUR = 1400;

/**
 * 조각이 회전이 풀리면서 제자리로 날아가 붙는다.
 *
 * 라운드가 끝난 뒤에만 부른다 — 여기서 처음으로 원본과 섹터 번호를 받기 때문이다.
 * 분할 계산은 서버와 같은 순수 함수를 쓴다.
 */
export function revealRound(
  el: HTMLCanvasElement,
  drawing: Point[][],
  sliceCount: number,
  owners: Array<{ sliceIndex: number; playerId: string | null }>,
  youId: string,
): void {
  const ctx = el.getContext('2d')!;
  const pieces = slice(drawing, sliceCount);
  const mine = owners.find((o) => o.playerId === youId)?.sliceIndex ?? -1;
  const step = (Math.PI * 2) / sliceCount;
  const start = performance.now();

  const frame = (t: number) => {
    const raw = Math.min(1, (t - start) / DUR);
    const k = 1 - Math.pow(1 - raw, 3); // ease-out

    const scale = fitCanvas(el);
    ctx.save();
    ctx.scale(scale, scale);
    ctx.clearRect(0, 0, CANVAS, CANVAS);

    ctx.beginPath();
    ctx.arc(CENTER[0], CENTER[1], RADIUS - 2, 0, Math.PI * 2);
    ctx.fillStyle = '#f6efe2';
    ctx.fill();

    for (const p of pieces) {
      const home = (p.index + 0.5) * step;
      // 조각의 좌표는 위(-90°)를 향해 있다. 제자리 각도까지 되돌린다.
      const back = (home - (-Math.PI / 2)) * k;

      ctx.save();
      ctx.translate(CENTER[0], CENTER[1]);
      ctx.rotate(back);
      ctx.translate(-CENTER[0], -CENTER[1]);

      // 부채꼴 경계선
      ctx.beginPath();
      ctx.moveTo(CENTER[0], CENTER[1]);
      ctx.arc(CENTER[0], CENTER[1], RADIUS - 2, -Math.PI / 2 - step / 2, -Math.PI / 2 + step / 2);
      ctx.closePath();
      ctx.strokeStyle = p.index === mine ? '#e0803a' : '#d9c9a8';
      ctx.lineWidth = p.index === mine ? 6 : 2;
      ctx.stroke();

      ctx.save();
      ctx.clip();
      drawStrokes(ctx, p.strokes);
      ctx.restore();
      ctx.restore();
    }

    ctx.restore();
    if (raw < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
