import type { Point } from '../shared/drawing';
import { CANVAS, CENTER, RADIUS, insideCircle } from '../shared/drawing';
import { drawStrokes, fitCanvas } from './ink';

export interface CanvasOpts {
  /** 그릴 수 있는가. 대기·추론 화면에서는 false */
  interactive: boolean;
}

/**
 * 원형 캔버스. 원 밖에는 그릴 수 없다.
 *
 * 원 밖을 막아두는 덕분에 서버가 조각을 자를 때 반지름 클리핑이 아예 필요 없어진다.
 */
export class CircleCanvas {
  private ctx: CanvasRenderingContext2D;
  private strokes: Point[][] = [];
  private current: Point[] | null = null;
  private strokeFn: ((points: Point[]) => void) | null = null;
  private pointFn: ((p: Point) => void) | null = null;

  constructor(private el: HTMLCanvasElement, private opts: CanvasOpts) {
    this.ctx = el.getContext('2d')!;
    this.resize();
    // 창 크기가 바뀌면 다시 그린다. 숨겨진 상태에서 그려 폭 0으로 뭉개는 것도 이걸로 풀린다.
    new ResizeObserver(() => this.resize()).observe(el);

    if (!opts.interactive) return;

    el.addEventListener('pointerdown', (e) => {
      const p = this.toCanvas(e);
      if (!insideCircle(p)) return;
      el.setPointerCapture(e.pointerId);
      this.current = [p];
      this.pointFn?.(p);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.current) return;
      const p = this.toCanvas(e);
      if (!insideCircle(p)) return;
      this.current.push(p);
      this.pointFn?.(p);
      this.draw();
    });
    const end = () => {
      if (!this.current) return;
      if (this.current.length >= 2) {
        this.strokes.push(this.current);
        this.strokeFn?.(this.current);
      }
      this.current = null;
      this.draw();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', end);
  }

  onStroke(fn: (points: Point[]) => void): void { this.strokeFn = fn; }
  onPoint(fn: (p: Point) => void): void { this.pointFn = fn; }

  render(strokes: Point[][]): void {
    this.strokes = strokes.map((s) => s.slice());
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
    ctx.strokeStyle = '#d9c9a8';
    ctx.stroke();

    drawStrokes(ctx, this.current ? [...this.strokes, this.current] : this.strokes);
    ctx.restore();
  }
}
