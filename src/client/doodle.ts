import type { Point } from '../shared/drawing';
import { DOODLE_W, DOODLE_H } from '../shared/drawing';
import { PALETTE } from '../shared/palette';
import { drawStrokes, fitRect } from './ink';
import { eraseStrokes, DOODLE_ERASE_RADIUS, MAX_ERASE_STEP } from '../shared/eraser';

/**
 * 대기 화면 낙서판.
 *
 * 출제자가 그리는 90초 동안 나머지는 할 일이 없었다. 빈 화면을 보고 기다리느니
 * 같이 갈기게 둔다. 게임 판정과는 아무 상관이 없는 판이라, 원형 캔버스처럼
 * 원 밖을 막거나 좌표를 숨길 이유도 없다.
 *
 * 색은 각자 고른다. 아무것도 안 고르면 id에서 뽑은 색이 기본값이라,
 * 여럿이 겹쳐 그려도 처음부터 구분이 된다.
 */
/**
 * 낙서판 팔레트. 그리는 캔버스와 같은 18색을 쓴다.
 *
 * 다만 여기서 색은 **누가 그렸나**를 나른다. 그래서 처음 배정만은 서버가 앞에서부터
 * 서로 다르게 준다(Session.ensureDoodleColor). 고르는 것은 전부 열려 있다.
 */
export const COLORS: readonly string[] = PALETTE;

/** 같은 사람은 언제나 같은 색이다. 자리 순서에 기대면 누가 나갈 때마다 색이 바뀐다. */
export function doodleColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

export interface DoodleStroke {
  by: string;
  points: Point[];
  /** 그린 사람이 고른 색. 예전 획에는 없을 수 있어 없으면 id에서 뽑는다. */
  color?: string;
}

export class DoodleBoard {
  private ctx: CanvasRenderingContext2D;
  private strokes: DoodleStroke[] = [];
  private current: Point[] | null = null;
  private strokeFn: ((points: Point[]) => void) | null = null;
  private erasePointFn: ((p: Point) => void) | null = null;
  private eraseEndFn: (() => void) | null = null;
  private eraseFrom: Point | null = null;
  private tool: 'pen' | 'eraser' = 'pen';

  constructor(private el: HTMLCanvasElement, private meId: () => string) {
    this.ctx = el.getContext('2d')!;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(el);

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      const p = this.toCanvas(e);
      if (this.tool === 'eraser') { this.eraseFrom = null; this.eraseAt(p); return; }
      this.current = [p];
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.toCanvas(e);
      if (this.tool === 'eraser') { if (e.buttons > 0) this.eraseAt(p); return; }
      if (!this.current) return;
      this.current.push(p);
      this.draw();
    });
    const end = () => {
      if (this.tool === 'eraser') {
        // 경로를 끊는다. 안 끊으면 다음에 누른 자리와 여기가 이어진다.
        this.eraseFrom = null;
        this.eraseEndFn?.();
      }
      if (!this.current) return;
      const done = this.current;
      this.current = null;
      // 점 하나짜리는 서버가 버린다. 화면에도 남기지 않아야 내 화면과 남의 화면이 같다.
      if (done.length >= 2) {
        this.strokes.push({ by: this.meId(), points: done, color: this.getColor() });
        this.strokeFn?.(done);
      }
      this.draw();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', end);
  }

  onStroke(fn: (points: Point[]) => void): void { this.strokeFn = fn; }
  onErasePoint(fn: (p: Point) => void): void { this.erasePointFn = fn; }
  onEraseEnd(fn: () => void): void { this.eraseEndFn = fn; }

  setTool(t: 'pen' | 'eraser'): void { this.tool = t; }
  getTool(): 'pen' | 'eraser' { return this.tool; }

  /**
   * 지우개가 지나온 자리의 잉크를 지운다. 내가 그은 것만 — 남의 낙서는 안 물린다.
   *
   * 서버도 같은 확인을 한다. 여기서 거르는 것은 남의 선 위에서 지우개를 문질렀을 때
   * 화면에서만 사라졌다가 되살아나는 꼴을 안 보려는 것이다.
   */
  private eraseAt(p: Point): void {
    const from = this.eraseFrom ?? p;
    const jumped = Math.hypot(p[0] - from[0], p[1] - from[1]) > MAX_ERASE_STEP;
    const a = jumped ? p : from;
    this.eraseFrom = p;

    const me = this.meId();
    const after = eraseStrokes(this.strokes, a, p, DOODLE_ERASE_RADIUS, (s) => s.by === me);
    if (after) {
      this.strokes = after;
      this.draw();
    }

    this.erasePointFn?.(p);
  }

  /** 지금 고른 색. 처음에는 내 id에서 뽑은 색으로 시작한다. */
  private color = '';
  setColor(c: string): void { this.color = c; }
  getColor(): string { return this.color || doodleColor(this.meId()); }

  /** 남이 그은 획 하나가 도착했다. 내가 그은 것은 이미 화면에 있으므로 버린다. */
  add(stroke: DoodleStroke): void {
    if (stroke.by === this.meId()) return;
    this.strokes.push(stroke);
    this.draw();
  }

  /** 판 전체를 서버가 준 것으로 맞춘다 (새로 들어왔거나 누가 자기 낙서를 지웠을 때). */
  setBoard(strokes: DoodleStroke[]): void {
    this.strokes = strokes.map((s) => ({ by: s.by, points: s.points.slice(), color: s.color }));
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

    // 그리는 중인 획에도 지금 고른 색을 붙인다.
    //
    // 예전에는 색 없이 넣었다. 그러면 아래 `s.color ?? doodleColor(s.by)`가 **id에서 뽑은
    // 기본색**으로 떨어져서, 긋는 동안은 기본색으로 보이다가 손을 떼는 순간(그때야
    // color가 붙는다) 고른 색으로 바뀌었다. 쓰는 사람 눈에는 "선이 먼저 나오고 색이
    // 나중에 입혀지는" 것으로 보인다. 서버 왕복과는 아무 상관이 없었다.
    const all = this.current
      ? [...this.strokes, { by: this.meId(), points: this.current, color: this.getColor() }]
      : this.strokes;
    for (const s of all) {
      drawStrokes(ctx, [{ points: s.points, color: s.color ?? doodleColor(s.by) }], { width: 10 });
    }
    ctx.restore();
  }
}
