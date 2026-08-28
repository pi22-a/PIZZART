import type { Stroke } from '../shared/drawing';
import { CANVAS, CENTER, RADIUS } from '../shared/drawing';
import type { RoundRecap } from '../shared/protocol';
import { drawStrokes } from './ink';

/**
 * 한 판을 한 장의 그림으로 만든다.
 *
 * 최종 순위는 숫자 몇 줄이라 남에게 보여줄 것이 못 된다. 남는 것은 그림이다 —
 * "아 그게 낙타였어?"가 나오는 그 그림들. 그래서 판이 다 끝난 뒤에 아홉 장을 한꺼번에
 * 모아 내보낸다. 회차마다 저장 버튼을 두던 예전 방식은 두 가지가 나빴다: 결과 화면에서
 * 흐름이 끊기고, 아홉 장이 아홉 개의 파일로 흩어져 아무도 다시 안 본다.
 *
 * 서버는 그림을 보내주기만 한다. 그리는 일은 전부 여기서 한다 — 서버에 올려 링크로
 * 주는 길은 일부러 안 갔다. 남이 그린 그림이 영구 주소로 남으면 신고를 받아줄 사람이
 * 있어야 한다.
 */

/** 공유 그림의 색. 화면 테마와 무관하게 늘 같은 것이 나가야 한다 — 받는 사람은 남이다. */
const BG = '#1c1712';
const DOUGH = '#f6efe2';
const INK = '#2b2118';
const SAUCE = '#e0803a';
const FG = '#f6efe2';
const CRUST = '#d9c9a8';

const W = 900;
const PAD = 48;
const GAP = 24;
const FONT = 'system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif';

/**
 * 원판 하나를 그린다. 조각 경계선까지 같이 그어야 "잘라서 나눠 가졌다"가 보인다.
 *
 * @param size 화면에 나갈 지름. 안쪽은 늘 0~1000 좌표라 배율만 맞춰주면 된다.
 */
function drawPie(
  ctx: CanvasRenderingContext2D,
  drawing: Stroke[],
  sliceCount: number,
  x: number,
  y: number,
  size: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / CANVAS, size / CANVAS);
  ctx.beginPath();
  ctx.arc(CENTER[0], CENTER[1], RADIUS - 2, 0, Math.PI * 2);
  ctx.fillStyle = DOUGH;
  ctx.fill();
  ctx.save();
  ctx.clip();
  // 색은 그린 사람이 고른 그대로 나간다. 통일해 버리면 그림이 달라진다.
  drawStrokes(ctx, drawing);
  ctx.restore();
  if (sliceCount > 0) {
    const step = (Math.PI * 2) / sliceCount;
    ctx.strokeStyle = CRUST;
    ctx.lineWidth = 3;
    for (let i = 0; i < sliceCount; i++) {
      ctx.beginPath();
      ctx.moveTo(CENTER[0], CENTER[1]);
      ctx.lineTo(
        CENTER[0] + Math.cos(i * step) * (RADIUS - 2),
        CENTER[1] + Math.sin(i * step) * (RADIUS - 2),
      );
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** 그림이 몇 장이냐에 따라 한 줄에 몇 개를 놓을지. 한 장짜리를 3열로 놓으면 우표만 해진다. */
function columns(n: number): number {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  return 3;
}

/**
 * 이 판의 그림 전부와 최종 순위를 한 장으로 만든다.
 *
 * @param ranking 그림 아래에 붙는다. 순위만 있는 그림은 안 보내지만, 그림에 순위가
 *   붙어 있으면 "누가 이겼냐"는 물음에 한 번 더 답이 된다.
 */
export function drawGalleryCard(
  canvas: HTMLCanvasElement,
  rounds: RoundRecap[],
  ranking: Array<{ name: string; score: number }>,
): void {
  const cols = columns(rounds.length);
  const cell = (W - PAD * 2 - GAP * (cols - 1)) / cols;
  const capH = 74; // 제시어 한 줄 + 누가 그렸나 한 줄
  const rows = Math.ceil(rounds.length / cols);
  const gridH = rows === 0 ? 0 : rows * (cell + capH) + (rows - 1) * GAP;
  const rankH = ranking.length === 0 ? 0 : 44 + ranking.length * 38;
  const H = PAD + 64 + gridH + (rankH > 0 ? 32 + rankH : 0) + PAD + 28;

  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'top';

  ctx.fillStyle = SAUCE;
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillText(`오늘의 그림 ${rounds.length}장`, PAD, PAD);

  let y = PAD + 64;
  rounds.forEach((r, i) => {
    const cx = PAD + (i % cols) * (cell + GAP);
    const cy = y + Math.floor(i / cols) * (cell + capH + GAP);
    drawPie(ctx, r.drawing, r.sliceCount, cx, cy, cell);

    ctx.fillStyle = SAUCE;
    ctx.font = `bold 30px ${FONT}`;
    ctx.fillText(r.word, cx, cy + cell + 12);
    ctx.fillStyle = FG;
    ctx.globalAlpha = 0.6;
    ctx.font = `20px ${FONT}`;
    const got = r.correct.length === 0 ? '아무도 못 맞힘' : `${r.correct.length}명 맞힘`;
    ctx.fillText(`${r.drawer} · ${got}`, cx, cy + cell + 48);
    ctx.globalAlpha = 1;
  });
  y += gridH;

  if (rankH > 0) {
    y += 32;
    ctx.fillStyle = FG;
    ctx.globalAlpha = 0.6;
    ctx.font = `22px ${FONT}`;
    ctx.fillText('최종 순위', PAD, y);
    ctx.globalAlpha = 1;
    y += 44;
    ctx.font = `26px ${FONT}`;
    ranking.forEach((p, i) => {
      ctx.fillStyle = i === 0 ? SAUCE : FG;
      ctx.globalAlpha = i === 0 ? 1 : 0.75;
      ctx.fillText(`${i + 1}. ${p.name}   ${p.score}점`, PAD, y);
      y += 38;
    });
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = FG;
  ctx.globalAlpha = 0.35;
  ctx.font = `22px ${FONT}`;
  ctx.fillText('P I Z Z A', PAD, H - PAD + 4);
  ctx.globalAlpha = 1;
}

/**
 * 이 브라우저가 그림을 공유창으로 넘길 수 있는가.
 *
 * 기기 이름(user agent)으로 폰인지 보지 않는다 — 그건 자주 틀리고, 되는지 안 되는지를
 * 직접 물어볼 수 있는 자리에서 굳이 짐작할 이유가 없다. 가짜 파일 하나로 물어본다.
 *
 * 이걸로 버튼 글자를 정한다. 폰에서 '그림으로 저장'이라고 적어두면 공유창이 뜨는 것이
 * 놀랍고, PC에서 '공유하기'라고 적어두면 파일이 내려와서 또 놀란다.
 */
export function canSharePng(): boolean {
  try {
    const probe = new File([new Uint8Array(1)], 'p.png', { type: 'image/png' });
    const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
    return typeof nav.share === 'function' && nav.canShare?.({ files: [probe] }) === true;
  } catch {
    return false;
  }
}

/**
 * 만든 그림을 내보낸다. 폰에서는 공유창을, 아니면 내려받기를 쓴다.
 *
 * 두 갈래를 두는 것은 브라우저마다 되는 것이 다르기 때문이다. 폰에서 바로 카톡으로
 * 보내는 것이 이 기능의 전부인데, 그게 안 되는 자리에서 아무 일도 안 일어나면
 * 사람들은 버튼이 고장 난 줄 안다.
 */
export async function shareCard(canvas: HTMLCanvasElement, caption: string): Promise<string> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) return '그림을 만들지 못했습니다';

  const file = new File([blob], 'pizza.png', { type: 'image/png' });
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] }) === true) {
    try {
      await nav.share({ files: [file], text: caption });
      return '';
    } catch {
      // 사용자가 공유창을 닫은 것이다. 실패가 아니므로 조용히 넘어간다.
      return '';
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  // 곧바로 지우면 내려받기가 시작되기 전에 주소가 사라지는 브라우저가 있다.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return '그림으로 저장했습니다';
}
