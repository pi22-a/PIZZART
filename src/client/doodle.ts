import type { Point } from '../shared/drawing';
import { DOODLE_W, DOODLE_H } from '../shared/drawing';
import { drawStrokes, fitRect } from './ink';

/**
 * 대기 화면 낙서판.
 *
 * 출제자가 그리는 90초 동안 나머지는 할 일이 없었다. 빈 화면을 보고 기다리느니
 * 같이 갈기게 둔다. 게임 판정과는 아무 상관이 없는 판이라, 원형 캔버스처럼
 * 원 밖을 막거나 좌표를 숨길 이유도 없다.
 *
 * 사람마다 색이 다르다 — 여럿이 겹쳐 그리면 누가 뭘 그렸는지 구분이 안 된다.
 */
const COLORS = [
  '#e0803a', '#6fb6e8', '#83cf7d', '#e6cf63', '#d98fbf',
  '#7fd6cc', '#f0937a', '#a99ae8', '#c3d17e',
];

/** 같은 사람은 언제나 같은 색이다. 자리 순서에 기대면 누가 나갈 때마다 색이 바뀐다. */
export function doodleColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

export interface DoodleStroke {
  by: string;
  points: Point[];
}

export class DoodleBoard {
  private ctx: CanvasRenderingContext2D;
  private strokes: DoodleStroke[] = [];
  private current: Point[] | null = null;
  private strokeFn: ((points: Point[]) => void) | null = null;

  constructor(private el: HTMLCanvasElement, private meId: () => string) {
    this.ctx = el.getContext('2d')!;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(el);

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.current = [this.toCanvas(e)];
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.current) return;
      this.current.push(this.toCanvas(e));
      this.draw();
    });
    const end = () => {
      if (!this.current) return;
      const done = this.current;
      this.current = null;
      // 점 하나짜리는 서버가 버린다. 화면에도 남기지 않아야 내 화면과 남의 화면이 같다.
      if (done.length >= 2) {
        this.strokes.push({ by: this.meId(), points: done });
        this.strokeFn?.(done);
      }
      this.draw();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', end);
  }

  onStroke(fn: (points: Point[]) => void): void { this.strokeFn = fn; }

  /** 남이 그은 획 하나가 도착했다. 내가 그은 것은 이미 화면에 있으므로 버린다. */
  add(stroke: DoodleStroke): void {
    if (stroke.by === this.meId()) return;
    this.strokes.push(stroke);
    this.draw();
  }

  /** 판 전체를 서버가 준 것으로 맞춘다 (새로 들어왔거나 누가 자기 낙서를 지웠을 때). */
  setBoard(strokes: DoodleStroke[]): void {
    this.strokes = strokes.map((s) => ({ by: s.by, points: s.points.slice() }));
    this.draw();
  }

  /** 내가 그은 것만 화면에서 지운다. 서버에도 같은 요청을 따로 보낸다. */
  clearMine(): void {
    this.strokes = this.strokes.filter((s) => s.by !== this.meId());
    this.draw();
  }

  clear(): void {
    this.strokes = [];
    this.current = null;
    this.draw();
  }

  private resize(): void {
    fitRect(this.el, DOODLE_W, DOODLE_H);
    this.draw();
  }

  private toCanvas(e: PointerEvent): Point {
    const r = this.el.getBoundingClientRect();
    return [
      ((e.clientX - r.left) / Math.max(1, r.width)) * DOODLE_W,
      ((e.clientY - r.top) / Math.max(1, r.height)) * DOODLE_H,
    ];
  }

  private draw(): void {
    const { ctx, el } = this;
    const scale = fitRect(el, DOODLE_W, DOODLE_H);
    ctx.save();
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.scale(scale, scale);

    ctx.fillStyle = '#f6efe2';
    ctx.fillRect(0, 0, DOODLE_W, DOODLE_H);

    const all = this.current
      ? [...this.strokes, { by: this.meId(), points: this.current }]
      : this.strokes;
    for (const s of all) {
      drawStrokes(ctx, [s.points], { color: doodleColor(s.by), width: 10 });
    }
    ctx.restore();
  }
}
