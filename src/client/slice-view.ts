import type { Point } from '../shared/drawing';
import { CANVAS, CENTER, RADIUS } from '../shared/drawing';
import { drawStrokes, fitCanvas } from './ink';

/**
 * 조각을 캔버스에 채우는 여유율. 1이면 바운딩 박스가 캔버스에 꽉 맞는다.
 *
 * 0.92였을 때는 (1000-920)/2 = 40 유닛만 남아, 300x300 캔버스 기준 위쪽 12px·아래쪽
 * 9px 정도만 비어 잘린 것처럼 보였다(오너가 실제로 측정한 값). 0.80은 (1000-800)/2 = 100
 * 유닛, 같은 캔버스 기준 약 30px — 액자에서 확실히 떨어져 보인다.
 */
export const SLICE_PADDING = 0.80;

/**
 * 조각의 바운딩 박스와, 그걸 캔버스(CANVAS x CANVAS)에 맞추는 배율을 계산한다.
 * drawSlice의 확대 로직과 Fix 1의 여백 산수를 같은 곳에서 재사용·테스트하려고 뺐다.
 */
export function computeSliceZoom(
  sliceCount: number,
  padding: number = SLICE_PADDING,
): { zoom: number; boxW: number; boxH: number } {
  const half = Math.PI / sliceCount;
  // 조각은 1000x1000 칸의 위쪽 좁은 영역에만 그려지므로(꼭짓점이 중심, 호가 위쪽 절반까지),
  // 조각의 바운딩 박스를 계산해 화면 가득 차도록 확대·중앙 정렬한다.
  const boxW = 2 * RADIUS * Math.sin(half);
  const boxH = RADIUS;
  const zoom = padding * Math.min(CANVAS / boxW, CANVAS / boxH);
  return { zoom, boxW, boxH };
}

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

  const { zoom } = computeSliceZoom(sliceCount);
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
