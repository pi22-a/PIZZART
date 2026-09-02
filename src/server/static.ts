import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * 빌드 결과물(dist/)을 그대로 내보낸다.
 *
 * 프로덕션에서는 Vite가 안 돈다. 개발 서버는 고칠 때마다 다시 읽고 모듈을 쪼개 보내는
 * 물건이라 그 자리에 둘 것이 아니고, 그러자고 앞에 웹서버를 하나 더 세우면 관리할
 * 프로세스가 늘어난다. **게임 서버 하나가 화면과 웹소켓을 같이 내주는 것**이 가장 간단하다.
 *
 * dist/가 없으면(개발 중) 아무것도 안 한다 — 그때는 Vite가 화면을 맡고 여기로는
 * /ws 만 넘어온다.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export function serveStatic(dir: string) {
  const on = existsSync(join(dir, 'index.html'));

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!on) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    /*
     * 주소 한 줄로 서버가 죽지 않게 한다.
     *
     * `//`로 온 요청에서 실제로 터졌다. `new URL('//', 'http://x')`는 그것을
     * **프로토콜 상대 주소**로 읽어서 호스트가 비었다고 예외를 던지고, 요청 처리 중의
     * 예외는 노드 프로세스를 통째로 내린다. 즉 아무나 주소 한 번으로 판을 끝낼 수 있었다.
     *
     * 그래서 앞의 슬래시를 하나로 접어서 넘기고, 그래도 안 되면 잘못된 요청으로 끝낸다.
     */
    let rel: string;
    try {
      const path = (req.url || '/').replace(/^\/+/, '/');
      const url = new URL(path, 'http://x');
      // 상위 경로로 빠져나가는 것을 막는다. normalize 뒤에도 ..이 남으면 거절한다.
      rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    } catch {
      res.writeHead(400).end();
      return true;
    }
    if (rel.includes('..')) { res.writeHead(400).end(); return true; }

    let file = join(dir, rel);
    // 폴더거나 없는 경로는 화면 하나짜리 앱이므로 index.html로 보낸다.
    // 다만 확장자가 있는데 없는 파일은 진짜 404다 — 없는 그림에 HTML을 주면 더 헷갈린다.
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(rel)) { res.writeHead(404).end(); return true; }
      file = join(dir, 'index.html');
    }

    const ext = extname(file).toLowerCase();
    const headers: Record<string, string> = {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    };

    /*
     * 캐시 규칙이 이 게임에서는 특히 중요하다.
     *
     * assets/ 안의 파일은 이름에 내용 해시가 박혀 있어 내용이 바뀌면 이름이 바뀐다.
     * 그래서 영원히 캐시해도 안전하다.
     *
     * 나머지(index.html, sw.js)는 **절대 캐시하면 안 된다.** 서버가 규칙을 쥐고 있어서
     * 오래된 화면이 캐시에서 살아나면 새 서버와 메시지 형식이 어긋난다. 특히 sw.js를
     * 캐시하면 고친 워커가 영영 안 퍼진다.
     */
    headers['Cache-Control'] = rel.startsWith('/assets/') || rel.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';

    const size = statSync(file).size;
    headers['Content-Length'] = String(size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return true; }
    createReadStream(file).pipe(res);
    return true;
  };
}
