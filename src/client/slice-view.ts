import type { Point } from '../shared/drawing';
import { CANVAS, CENTER, RADIUS } from '../shared/drawing';
import { drawStrokes, fitCanvas } from './ink';

/**
 * 조각 하나를 그린다. 좌표는 서버가 이미 위를 향하게 돌려서 보낸 것이다.
 * 꼭짓점이 중심에, 부채꼴이 위로 뻗는다.
 */
export function drawSlice(el: HTMLCanvasElement, strokes: Point[][], sliceCount: number): void {
  const ctx = el.getContext('2d')!;
  const scale = fitCanvas(el);
  ctx.save();
  ctx.clearRect(0, 0, el.width, el.height);
  ctx.scale(scale, scale);

  const half = Math.PI / sliceCount;
  const up = -Math.PI / 2;

  // 조각은 1000x1000 칸의 위쪽 좁은 영역에만 그려지므로(꼭짓점이 중심, 호가 위쪽 절반까지),
  // 조각의 바운딩 박스를 계산해 화면 가득 차도록 확대·중앙 정렬한다.
  const boxW = 2 * RADIUS * Math.sin(half);
  const boxH = RADIUS;
  const zoom = 0.92 * Math.min(CANVAS / boxW, CANVAS / boxH);
  const boxCx = CENTER[0];
  const boxCy = CENTER[1] - RADIUS / 2;
  ctx.translate(CANVAS / 2, CANVAS / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-boxCx, -boxCy);

  // 조각 모양(반죽)
  ctx.beginPath();
  ctx.moveTo(CENTER[0], CENTER[1]);
  ctx.arc(CENTER[0], CENTER[1], RADIUS - 2, up - half, up + half);
  ctx.closePath();
  ctx.fillStyle = '#f6efe2';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#d9c9a8';
  ctx.stroke();

  // 잉크는 조각 밖으로 새지 않게 잘라 그린다
  ctx.save();
  ctx.clip();
  drawStrokes(ctx, strokes);
  ctx.restore();
  ctx.restore();
}

/**
 * 회전 안내. 작은 원 안에서 부채꼴 하나가 둘레를 계속 돌아다닌다.
 *
 * "네 조각은 이 중 어디였는지 모른다"를 말 없이 전달한다. 텍스트로 쓰면 아무도 읽지 않는다.
 * 비틀린 규칙이 핵심일수록 그 비틀림을 화면에 그려야 한다 — TAKBON에서 배운 것이다.
 *
 * 돌려주는 함수를 부르면 멈춘다.
 */
export function startSpinHint(el: HTMLCanvasElement, sliceCount: number): () => void {
  const ctx = el.getContext('2d')!;
  let raf = 0;
  let stopped = false;
  const half = Math.PI / sliceCount;

  const frame = (t: number) => {
    if (stopped) return;
    fitCanvas(el);
    const s = el.width / 100; // 이 안내는 100x100 좌표계로 그린다
    ctx.save();
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.scale(s, s);

    ctx.beginPath();
    ctx.arc(50, 50, 44, 0, Math.PI * 2);
    ctx.strokeStyle = '#cbbfa8';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 8초에 한 바퀴, 조각 단위로 툭툭 끊어 돈다
    const step = (Math.PI * 2) / sliceCount;
    const at = Math.floor((t / 800) % sliceCount) * step + half;
    ctx.beginPath();
    ctx.moveTo(50, 50);
    ctx.arc(50, 50, 42, at - half, at + half);
    ctx.closePath();
    ctx.fillStyle = '#e0803a';
    ctx.fill();

    ctx.restore();
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => { stopped = true; cancelAnimationFrame(raf); };
}
