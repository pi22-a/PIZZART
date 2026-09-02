import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStatic } from '../src/server/static';

/**
 * 화면을 내주는 부분은 **아무나 주소를 보내는 자리**다. 판이 도는 중에 여기서 예외가
 * 나면 노드는 프로세스를 통째로 내리고, 방 상태가 메모리에만 있는 이 게임은 돌던 판이
 * 전부 날아간다. 그래서 이상한 주소로도 안 죽는지가 이 파일의 핵심이다.
 */
let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pizzart-static-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>화면</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'sw.js'), '// 워커');
  writeFileSync(join(dir, 'manifest.webmanifest'), '{}');

  const serve = serveStatic(dir);
  server = createServer((req, res) => {
    if (!serve(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('화면 서빙', () => {
  it('index.html을 낸다', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('화면');
  });

  it('없는 경로는 화면 하나짜리 앱이므로 index.html로 보낸다', async () => {
    expect((await fetch(`${base}/아무방`)).status).toBe(200);
  });

  it('확장자가 있는데 없는 파일은 404다', async () => {
    // 없는 그림 자리에 HTML을 주면 더 헷갈린다
    expect((await fetch(`${base}/없는그림.png`)).status).toBe(404);
  });
});

describe('주소 하나로 서버가 죽지 않는다', () => {
  // 실제로 겪었다. `//`로 온 요청에서 new URL이 예외를 던져 프로세스가 통째로 내려갔다.
  const 이상한주소 = ['//', '///', '/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/%ZZ', '/a%'];

  for (const u of 이상한주소) {
    it(`${u} 에도 응답하고 살아남는다`, async () => {
      const res = await fetch(`${base}${u}`);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(500);
    });
  }

  it('그 뒤에도 멀쩡히 화면을 낸다', async () => {
    for (const u of 이상한주소) await fetch(`${base}${u}`).catch(() => {});
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
  });

  it('바깥 파일을 절대 내주지 않는다', async () => {
    const body = await fetch(`${base}/../../etc/passwd`).then((r) => r.text());
    expect(body).not.toContain('root:');
  });
});

describe('캐시 규칙', () => {
  it('이름에 해시가 박힌 것만 영원히 캐시한다', async () => {
    const res = await fetch(`${base}/assets/index-abc123.js`);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('화면과 워커는 캐시하지 않는다', async () => {
    // 오래된 화면이 캐시에서 살아나면 새 서버와 메시지 형식이 어긋난다.
    // sw.js를 캐시하면 고친 워커가 영영 안 퍼진다.
    for (const p of ['/', '/sw.js']) {
      const res = await fetch(`${base}${p}`);
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
  });
});
