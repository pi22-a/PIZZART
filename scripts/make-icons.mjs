/**
 * 앱 아이콘을 만든다.
 *
 *   node scripts/make-icons.mjs
 *
 * 그림 소재는 게임의 정체 그대로다 — **부채꼴로 잘린 원**. 이 게임을 한 장으로
 * 설명하는 것이 그거라, 아이콘도 그것이어야 한다.
 *
 * 외부 라이브러리를 안 쓴다. PNG는 zlib(노드 기본 내장) 위에 얹은 아주 얇은 형식이라
 * 직접 쓰는 편이 낫다 — 아이콘 넉 장 만들자고 이미지 라이브러리를 의존성에 들이면
 * 이 저장소의 유일한 런타임 의존성이 ws 하나라는 장점이 사라진다.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons');

// 화면의 색 그대로. 아이콘만 따로 놀면 앱을 열었을 때 다른 앱처럼 보인다.
const BG = [24, 24, 24];        // #181818
const DOUGH = [246, 239, 226];  // #f6efe2
const CRUST = [217, 201, 168];  // #d9c9a8
const INK = [31, 27, 23];       // #1f1b17
const SAUCE = [224, 128, 58];   // #e0803a

const crc32 = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param px RGBA 픽셀 (size*size*4) */
function png(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // 8비트
  ihdr[9] = 6;   // RGBA
  // 스캔라인마다 앞에 필터 바이트가 붙는다. 0 = 필터 없음.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * @param inset 원이 차지하는 비율. maskable 아이콘은 바깥이 잘려 나가므로
 *   안쪽 80%(안전 영역)에만 그려야 모서리가 둥근 기기에서 안 잘린다.
 */
function draw(size, inset) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const r = (size / 2) * inset;
  const slices = 8;
  const step = (Math.PI * 2) / slices;
  // 경계선 두께와 계단 완화(안티에일리어싱)를 크기에 비례시킨다
  const edge = Math.max(1, size / 128);
  const aa = Math.max(1, size / 256);

  const put = (i, [r0, g0, b0], a) => {
    // 배경 위에 알파로 얹는다
    px[i] = Math.round(px[i] * (1 - a) + r0 * a);
    px[i + 1] = Math.round(px[i + 1] * (1 - a) + g0 * a);
    px[i + 2] = Math.round(px[i + 2] * (1 - a) + b0 * a);
    px[i + 3] = 255;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      put(i, BG, 1);

      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const d = Math.hypot(dx, dy);
      if (d > r + aa) continue;

      // 원 가장자리를 부드럽게
      const inCircle = Math.min(1, (r - d) / aa + 1);
      if (inCircle <= 0) continue;

      // 어느 조각인가. 한 조각만 소스색으로 칠해 "내 조각"을 나타낸다 —
      // 이 게임에서 사람이 손에 쥐는 것이 조각 하나라서다.
      const ang = (Math.atan2(dy, dx) + Math.PI * 2.5) % (Math.PI * 2);
      const idx = Math.floor(ang / step);
      put(i, idx === 1 ? SAUCE : DOUGH, inCircle);

      // 조각 경계선
      const off = ang % step;
      const toEdge = Math.min(off, step - off) * d;
      if (toEdge < edge) put(i, CRUST, (1 - toEdge / edge) * inCircle);

      // 원 테두리
      if (r - d < edge) put(i, CRUST, (1 - (r - d) / edge) * inCircle);
    }
  }
  return px;
}

mkdirSync(outDir, { recursive: true });
const made = [];
for (const [name, size, inset] of [
  ['icon-192.png', 192, 0.86],
  ['icon-512.png', 512, 0.86],
  // maskable은 바깥이 잘린다. 안전 영역(안쪽 80%) 안에만 그린다.
  ['icon-maskable-512.png', 512, 0.66],
  ['apple-touch-icon.png', 180, 0.86],
]) {
  const buf = png(draw(size, inset), size);
  writeFileSync(join(outDir, name), buf);
  made.push(`  ${name} — ${size}px, ${(buf.length / 1024).toFixed(1)}KB`);
}
console.log('아이콘을 만들었습니다 → public/icons/');
console.log(made.join('\n'));
