/*
 * 서비스 워커.
 *
 * **오프라인 플레이용이 아니다.** 이 게임은 실시간 멀티플레이라 서버 없이는 아무것도
 * 안 된다. 혼자 할 수 있는 것이 없는데 캐시로 붙잡아 둘 이유가 없다.
 *
 * 그런데도 워커가 필요한 이유는 두 가지다.
 *
 * 1. **설치 가능해지려면 있어야 한다.** 홈 화면에 깔거나 Play에 TWA로 올리려면
 *    워커가 등록되어 있어야 한다.
 * 2. **끊겼을 때 크롬 공룡 화면을 막는다.** TWA는 주소창이 없어서, 인터넷이 끊기면
 *    앱 안에 브라우저 오류 페이지가 통째로 뜬다. 쓰는 사람 눈에는 앱이 고장 난 것이다.
 *    그 자리에 우리 안내 화면을 대신 넣는다.
 *
 * 전략은 **network-first**다. 캐시를 먼저 보지 않는다.
 *
 * 왜냐하면 이 게임은 서버가 규칙을 쥐고 있어서, 오래된 클라이언트가 캐시에서 살아나면
 * 새 서버와 메시지 형식이 어긋날 수 있다. 그러면 "왜 갑자기 안 되지"가 되는데 원인을
 * 찾기가 아주 어렵다. 온라인일 때는 언제나 서버 것을 쓰고, 캐시는 오직 끊겼을 때의
 * 대비책으로만 둔다.
 */
const CACHE = 'pizza-v2';
const OFFLINE = 'offline.html';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll([OFFLINE, '.']))
      // 캐시를 못 채워도 설치는 넘어간다. 워커가 없는 것보다는 낫다.
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // GET만 다룬다. 웹소켓(/ws)은 애초에 여기로 안 오지만 명시해 둔다.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/ws')) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        // 성공한 것만 대비책으로 넣어둔다
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        /*
         * 화면을 여는 요청이면 **캐시된 게임 화면을 주지 않는다.**
         *
         * 처음엔 캐시를 먼저 뒤졌는데, 그러면 서버가 죽었을 때 게임 껍데기가 뜨고
         * 그 안에서 아무 화면도 안 켜져 **완전히 빈 페이지**가 됐다(실제로 확인했다).
         * 화면을 켜는 것은 서버가 보낸 방 상태이기 때문이다.
         *
         * 게임은 서버 없이는 어차피 못 한다. 빈 화면을 주느니 왜 안 되는지 말해준다.
         */
        if (req.mode === 'navigate') {
          return (await caches.match(OFFLINE))
            ?? new Response('인터넷 연결이 필요합니다', {
              status: 503,
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            });
        }
        // 그림·스크립트 같은 딸린 것들은 캐시가 있으면 준다
        const hit = await caches.match(req);
        if (hit) return hit;
        return new Response('', { status: 504 });
      }),
  );
});
