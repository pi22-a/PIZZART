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

/**
 * 출제자 전용. 지금 맞히는 사람들에게 나가 있는 조각을 밝게, 아직 숨은 조각을 어둡게 그린다.
 *
 * 출제자는 정답도 그림도 이미 알고 있으므로 여기에 원본을 그려도 새는 것이 없다.
 * 그리기가 끝나면 할 일이 없던 시간을, 남들이 무엇을 보고 헤매는지 지켜보는 시간으로 바꾼다.
 */
export function drawBoard(
  el: HTMLCanvasElement,
  drawing: Point[][],
  sliceCount: number,
  visible: number[],
): void {
  const ctx = el.getContext('2d')!;
  const scale = fitCanvas(el);
  const step = (Math.PI * 2) / sliceCount;
  const out = new Set(visible);

  ctx.save();
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, CANVAS, CANVAS);

  for (let i = 0; i < sliceCount; i++) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(CENTER[0], CENTER[1]);
    ctx.arc(CENTER[0], CENTER[1], RADIUS - 2, i * step, (i + 1) * step);
    ctx.closePath();
    // 나가 있는 조각만 반죽 색으로 밝게, 나머지는 배경에 가깝게 눕힌다
    ctx.fillStyle = out.has(i) ? '#f6efe2' : '#2b2118';
    ctx.fill();
    ctx.strokeStyle = '#3d3227';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.clip();
    if (out.has(i)) drawStrokes(ctx, drawing);
    ctx.restore();
  }
  ctx.restore();
}

/**
 * 마지막 회차의 조립판. 내가 본 조각을 회전이 풀린 제자리에 끼워 보여준다.
 *
 * 좌표는 서버가 이미 원래 방향으로 되돌려 보낸 것이라 그대로 그리면 된다.
 * 아직 못 본 칸은 어둡게 비워 둔다 — 어디가 비었는지가 그 자체로 단서다.
 */
export function drawAssembled(
  el: HTMLCanvasElement,
  pieces: Array<{ index: number; strokes: Point[][] }>,
  sliceCount: number,
): void {
  const ctx = el.getContext('2d')!;
  const scale = fitCanvas(el);
  const step = (Math.PI * 2) / sliceCount;
  const have = new Map(pieces.map((p) => [p.index, p.strokes]));

  ctx.save();
  ctx.scale(scale, scale);
  ctx.clearRect(0, 0, CANVAS, CANVAS);

  for (let i = 0; i < sliceCount; i++) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(CENTER[0], CENTER[1]);
    ctx.arc(CENTER[0], CENTER[1], RADIUS - 2, i * step, (i + 1) * step);
    ctx.closePath();
    ctx.fillStyle = have.has(i) ? '#f6efe2' : '#241d16';
    ctx.fill();
    ctx.strokeStyle = '#3d3227';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.clip();
    const st = have.get(i);
    if (st) drawStrokes(ctx, st);
    ctx.restore();
  }
  ctx.restore();
}
