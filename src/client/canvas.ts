import type { Point, Stroke } from '../shared/drawing';
import { CANVAS, CENTER, RADIUS, insideCircle } from '../shared/drawing';
import { DEFAULT_COLOR } from '../shared/palette';
import { drawStrokes, fitCanvas } from './ink';

/** 지우개가 획을 물었다고 볼 거리(0~1000 좌표계). 선 굵기 8의 두 배쯤이라 손이 안 떨려도 잡힌다. */
const ERASE_HIT = 18;

/** 점에서 선분까지의 거리. 지우개가 어느 획을 물었는지 고르는 데만 쓴다. */
function distToSegment(p: Point, a: Point, b: Point): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  // 길이 0인 선분(같은 점 두 개)은 점까지의 거리로 친다
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  const dx = p[0] - (a[0] + vx * t);
  const dy = p[1] - (a[1] + vy * t);
  return Math.hypot(dx, dy);
}

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
  private eraseFn: ((index: number) => void) | null = null;
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
      if (!insideCircle(p)) return;
      el.setPointerCapture(e.pointerId);
      // 지우개는 누른 자리에서 바로 문다. 끌면 지나가는 획을 계속 지운다.
      if (this.tool === 'eraser') { this.eraseAt(p); return; }
      this.current = [p];
      this.pointFn?.(p);
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.toCanvas(e);
      if (!insideCircle(p)) return;
      if (this.tool === 'eraser') { if (e.buttons > 0) this.eraseAt(p); return; }
      if (!this.current) return;
      this.current.push(p);
      this.pointFn?.(p);
      this.draw();
    });
    const end = () => {
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
  onErase(fn: (index: number) => void): void { this.eraseFn = fn; }

  setColor(c: string): void { this.color = c; }
  getColor(): string { return this.color; }
  setTool(t: Tool): void { this.tool = t; }
  getTool(): Tool { return this.tool; }

  /**
   * 지우개가 문 획을 지운다. 화면에서 먼저 빼고 서버에 알린다 —
   * 서버가 canvas를 되보내주므로 어긋나도 곧 맞춰진다.
   */
  private eraseAt(p: Point): void {
    // 나중에 그은 획이 위에 있다. 눈에 보이는 것부터 지워야 손과 화면이 맞는다.
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const pts = this.strokes[i].points;
      for (let j = 1; j < pts.length; j++) {
        if (distToSegment(p, pts[j - 1], pts[j]) <= ERASE_HIT) {
          this.strokes.splice(i, 1);
          this.draw();
          this.eraseFn?.(i);
          return;
        }
      }
    }
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
    ctx.strokeStyle = '#d9c9a8';
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
