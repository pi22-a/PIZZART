import type { Point } from '../shared/drawing';
import { CANVAS, CENTER, RADIUS } from '../shared/drawing';
import { drawStrokes } from './ink';

/**
 * 한 라운드를 한 장의 그림으로 만든다.
 *
 * 최종 순위는 숫자 몇 줄이라 남에게 보여줄 것이 못 된다. 남는 것은 정답이 뜨는 그 순간
 * — 원본 그림과 **다들 뭐라고 답했는지**다. "아 그게 낙타였어?"가 나오는 화면이 그것이다.
 *
 * 서버는 아무것도 안 한다. 그림도 답도 이미 화면이 들고 있는 값이라 보이지 않는
 * 캔버스에 다시 그리기만 하면 된다. 서버에 올려 링크로 주는 길은 일부러 안 갔다 —
 * 남이 그린 그림이 영구 주소로 남으면 신고를 받아줄 사람이 있어야 한다.
 */
export interface ShareRow {
  name: string;
  text: string;
  correct: boolean;
}

/** 공유 그림의 색. 화면 테마와 무관하게 늘 같은 것이 나가야 한다 — 받는 사람은 남이다. */
const BG = '#1c1712';
const DOUGH = '#f6efe2';
const INK = '#2b2118';
const SAUCE = '#e0803a';
const FG = '#f6efe2';
const CRUST = '#d9c9a8';

const W = 900;
const PAD = 48;
const ART = 460;

export function drawShareCard(
  canvas: HTMLCanvasElement,
  word: string,
  drawing: Point[][],
  sliceCount: number,
  rows: ShareRow[],
): void {
  const lineH = 40;
  const H = PAD + 64 + ART + 28 + rows.length * lineH + PAD + 28;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = SAUCE;
  ctx.font = 'bold 40px system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(`정답: ${word}`, PAD, PAD);

  // 원판. 조각 경계선을 같이 그려야 "잘라서 나눠 가졌다"가 보인다.
  const top = PAD + 64;
  const scale = ART / CANVAS;
  ctx.save();
  ctx.translate((W - ART) / 2, top);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.arc(CENTER[0], CENTER[1], RADIUS - 2, 0, Math.PI * 2);
  ctx.fillStyle = DOUGH;
  ctx.fill();
  ctx.save();
  ctx.clip();
  drawStrokes(ctx, drawing, { color: INK });
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

  // 누가 뭐라고 냈는지. 이 줄들이 이 그림의 알맹이다.
  let y = top + ART + 28;
  ctx.font = '26px system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif';
  for (const r of rows) {
    ctx.fillStyle = r.correct ? SAUCE : FG;
    ctx.globalAlpha = r.correct ? 1 : 0.75;
    ctx.fillText(`${r.name}   ${r.text}`, PAD, y);
    y += lineH;
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = FG;
  ctx.globalAlpha = 0.35;
  ctx.font = '22px system-ui, sans-serif';
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
 * 세 갈래를 두는 것은 브라우저마다 되는 것이 다르기 때문이다. 폰에서 바로 카톡으로
 * 보내는 것이 이 기능의 전부인데, 그게 안 되는 자리에서 아무 일도 안 일어나면
 * 사람들은 버튼이 고장 난 줄 안다.
 */
export async function shareCard(canvas: HTMLCanvasElement, word: string): Promise<string> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) return '그림을 만들지 못했습니다';

  const file = new File([blob], `pizza-${word}.png`, { type: 'image/png' });
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] }) === true) {
    try {
      await nav.share({ files: [file], text: `PIZZA — 정답은 ${word}` });
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
