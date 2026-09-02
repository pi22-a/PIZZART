import type { Point, Stroke } from '../shared/drawing';
import { CANVAS, CENTER, RADIUS, insideCircle } from '../shared/drawing';
import { DEFAULT_COLOR } from '../shared/palette';
import { eraseStrokes, ERASE_RADIUS, MAX_ERASE_STEP } from '../shared/eraser';
import { drawStrokes, fitCanvas, isLight } from './ink';

export interface CanvasOpts {
  /** 그릴 수 있는가. 대기·추론 화면에서는 false */
  interactive: boolean;
}

export type Tool = 'pen' | 'eraser';

/**
 * 원형 캔버스. 원 밖에는 그릴 수 없다.
 *
 * 원 밖을 막아두는 덕분에 서버가 조각을 자를 때 반지름 클리핑이 아예 필요 없어진다.
 */
export class CircleCanvas {
  private ctx: CanvasRenderingContext2D;
  private strokes: Stroke[] = [];
  private current: Point[] | null = null;
  private strokeFn: ((points: Point[], color: string) => void) | null = null;
  private pointFn: ((p: Point) => void) | null = null;
  private erasePointFn: ((p: Point) => void) | null = null;
  private eraseEndFn: (() => void) | null = null;
  /** 지우개가 직전에 있던 자리. 여기서 지금 자리까지를 캡슐로 지운다. */
  private eraseFrom: Point | null = null;
  private color = DEFAULT_COLOR;
  private tool: Tool = 'pen';

  constructor(private el: HTMLCanvasElement, private opts: CanvasOpts) {
    this.ctx = el.getContext('2d')!;
    this.resize();
    // 창 크기가 바뀌면 다시 그린다. 숨겨진 상태에서 그려 폭 0으로 뭉개는 것도 이걸로 풀린다.
    new ResizeObserver(() => this.resize()).observe(el);

    if (!opts.interactive) return;

    el.addEventListener('pointerdown', (e) => {
      const p = this.toCanvas(e);
      // 지우개는 원 밖에서도 받는다. 잉크는 원 안에만 있으니 밖을 막을 이유가 없고,
      // 막으면 테두리에 바짝 붙은 선을 지우기가 유난히 어려워진다.
      if (this.tool !== 'eraser' && !insideCircle(p)) return;
      el.setPointerCapture(e.pointerId);
      // 지우개는 누른 자리에서 바로 문다. 끌면 지나온 자리를 계속 지운다.
      if (this.tool === 'eraser') { this.eraseFrom = null; this.eraseAt(p); return; }
      this.current = [p];
      this.pointFn?.(p);
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.toCanvas(e);
      if (this.tool === 'eraser') { if (e.buttons > 0) this.eraseAt(p); return; }
      if (!insideCircle(p)) return;
      if (!this.current) return;
      this.current.push(p);
      this.pointFn?.(p);
      this.draw();
    });
    const end = () => {
      if (this.tool === 'eraser') {
        // 경로를 끊는다. 안 끊으면 다음에 누른 자리와 여기가 이어져,
        // 지나지도 않은 자리가 쓸려나간다.
        this.eraseFrom = null;
        this.eraseEndFn?.();
      }
      if (!this.current) return;
      if (this.current.length >= 2) {
        this.strokes.push({ points: this.current, color: this.color });
        this.strokeFn?.(this.current, this.color);
      }
      this.current = null;
      this.draw();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', end);
  }

  onStroke(fn: (points: Point[], color: string) => void): void { this.strokeFn = fn; }
  onPoint(fn: (p: Point) => void): void { this.pointFn = fn; }
  onErasePoint(fn: (p: Point) => void): void { this.erasePointFn = fn; }
  onEraseEnd(fn: () => void): void { this.eraseEndFn = fn; }

  setColor(c: string): void { this.color = c; }
  getColor(): string { return this.color; }
  setTool(t: Tool): void { this.tool = t; }
  getTool(): Tool { return this.tool; }

  /**
   * 지우개가 지나온 자리의 잉크를 지운다. 화면에서 먼저 빼고 서버에는 **경로만** 보낸다 —
   * 자르는 것은 서버가 같은 코드로 다시 한다. 서버가 canvas를 되보내주므로 어긋나도 곧 맞춰진다.
   *
   * 지운 것이 없어도 점은 보낸다. 서버가 받는 경로가 내가 지나온 경로와 같아야
   * 두 쪽이 같은 자리를 지운다.
   */
  private eraseAt(p: Point): void {
    const from = this.eraseFrom ?? p;

    // 포인터가 껑충 뛰었으면(창 밖에 나갔다 왔거나 프레임이 밀렸거나) 이어 지우지 않는다.
    // 서버도 같은 규칙으로 건너뛴다.
    const jumped = Math.hypot(p[0] - from[0], p[1] - from[1]) > MAX_ERASE_STEP;
    const a = jumped ? p : from;
    this.eraseFrom = p;

    const after = eraseStrokes(this.strokes, a, p, ERASE_RADIUS);
    if (after) {
      this.strokes = after;
      this.draw();
    }

    this.erasePointFn?.(p);
  }

  render(strokes: Stroke[]): void {
    this.strokes = strokes.map((s) => ({ points: s.points.slice(), color: s.color }));
    this.draw();
  }

  clear(): void { this.render([]); }

  private resize(): void {
    fitCanvas(this.el);
    this.draw();
  }

  private toCanvas(e: PointerEvent): Point {
    const r = this.el.getBoundingClientRect();
    const size = Math.min(r.width, r.height);
    return [
      ((e.clientX - r.left) / size) * CANVAS,
      ((e.clientY - r.top) / size) * CANVAS,
    ];
  }

  private draw(): void {
    const { ctx, el } = this;
    const scale = fitCanvas(el);
    ctx.save();
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.scale(scale, scale);

    // 반죽
    ctx.beginPath();
    ctx.arc(CENTER[0], CENTER[1], RADIUS - 2, 0, Math.PI * 2);
    ctx.fillStyle = '#f6efe2';
    ctx.fill();
    ctx.lineWidth = 4;
    /*
     * 테두리 색이 테마를 타야 한다.
     *
     * 밝은 모드의 배경(#e9e0cf)과 반죽(#f6efe2)은 거의 같은 크림색이라, 원판이
     * 배경에서 떠오르는 정도가 1.1:1밖에 안 된다 — **이 게임의 주인공이 배경에 묻힌다.**
     * 테두리마저 크러스트색이면 윤곽도 안 잡힌다(1.25:1).
     *
     * 조각판과 조립판은 이미 이렇게 하고 있었다(reveal.ts, slice-view.ts).
     * 그리는 캔버스만 빠져 있었다.
     */
    ctx.strokeStyle = isLight() ? '#a8977c' : '#d9c9a8';
    ctx.stroke();

    // 그리는 중인 획도 고른 색 그대로 나가야 한다. 기본색으로 그렸다가 손을 떼는 순간
    // 색이 바뀌면, 쓰는 사람은 "선이 먼저 나오고 색이 나중에 입혀진다"고 느낀다.
    drawStrokes(
      ctx,
      this.current ? [...this.strokes, { points: this.current, color: this.color }] : this.strokes,
    );
    ctx.restore();
  }
}
