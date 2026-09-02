# 배포와 릴리스

웹이 메인 제품이 되면서 필요해진 문서다. **지금 서버에 떠 있는 것이 무엇인지**를
언제나 알 수 있어야 하고, 문제가 생겼을 때 되돌릴 방법이 있어야 한다.

관련 문서 — 서명 키와 스토어 자산은 저장소 밖 금고에 있다 → `../PIZZART-release/README.md`

## 도메인 — `pizzagame.app` (2026-08-31 확정, 2026-09-02 재확인)

> **게임 이름을 PIZZART로 바꾼 뒤에도 도메인은 그대로 둔다.** 한 번 검토하고 내린
> 결론이니 다시 꺼내지 않는다.
>
> `pizzart.app`과 `pizzart.com`은 이미 남의 것이고, `pizzart.game`은 **연 $300**이라
> 서버비의 다섯 배다. 남은 선택은 `pizzart.games`($26)나 `pizzart.io`($50)였는데,
> 둘 다 **얻는 것에 비해 값이 크다** — 도메인이 사용자 눈에 보이는 자리는 친구에게
> 링크를 보낼 때뿐이고, Play 목록에는 앱 이름(PIZZART)이 뜬다. `pizzagame.app`은
> 엉뚱하지도 수상하지도 않고 이미 배포·검증이 끝났다.
>
> **바꿀 수 있는 마지막 시점은 TWA 빌드 전이다.** 그 뒤에는 앱이 도메인에 묶여서
> 재빌드·재심사에 설치한 사용자까지 흔들린다. 그 시점을 알고도 안 바꾸기로 한 것이다.
>
> ⚠️ **그래서 이 도메인의 자동 갱신은 절대 꺼지면 안 된다.** 만료되면 설치된 앱이
> 전부 깨진다.

`.app`을 고른 이유는 **HSTS 프리로드 TLD**라서다. 브라우저가 이 TLD로는 평문 접속을
아예 안 한다. TWA가 어차피 HTTPS를 요구하므로 조건이 저절로 충족되고, 설정 실수로
평문으로 새는 경로가 하나 사라진다.

**TWA는 도메인에 앱을 묶는다.** 나중에 도메인을 바꾸면 assetlinks와 앱 설정을 다시
만들어야 하고, 이미 설치한 사용자는 따라오지 않는다. 그래서 이건 바꾸기 어려운 결정이다.

| 주소 | 쓰임 |
|---|---|
| `pizzagame.app` | **프로덕션.** TWA가 묶이는 곳. 사용자가 쓰는 판 |
| `staging.pizzagame.app` | 배포 전 확인용. 지금 `PIZZART-play` 워크트리가 하던 일 |

TWA는 최상위 하나에만 묶는다. 스테이징을 서브도메인으로 두면 앱이 그쪽으로 끌려가지
않는다 — assetlinks를 프로덕션에만 두기 때문이다.

등록처는 Cloudflare Registrar를 쓴다. 원가로 팔아 연장할 때 값이 안 뛰고, DNS가 같이 온다.

---

## 지금 상태 (2026-09-02)

**`https://pizzagame.app`이 살아 있다.** 다만 아직 서버가 아니라 **이 컴퓨터**를 가리킨다 —
Cloudflare 이름 붙인 터널로 이어둔 것이라 **컴퓨터가 꺼지면 같이 내려간다.**

| | 어디서 | 포트 | 무엇을 |
|---|---|---|---|
| **공개** | **AWS Lightsail** (`3.35.168.66`, 태그에 고정) | 8090 | `pizzagame.app` — 24시간 |
| **개발** | `PIZZART` (`v1.7` 브랜치) | 5173 / 8080 | 고치고 시험하는 곳 |
| 예비 | `PIZZART-play` 워크트리 | 8090 | 서버가 죽었을 때 노트북에서 임시로 |

**2026-09-02, 서버로 옮겼다.** 이제 노트북을 꺼도 `pizzagame.app`이 열려 있다.
`PIZZART-play`에서 `npm run public`을 돌리는 것은 **서버가 죽었을 때의 예비 수단**으로만
쓴다 — 그때도 서버의 cloudflared를 먼저 멈춰야 한다(방이 갈린다).

**공개는 개발 저장소에서 돌리지 않는다.** 한동안 그렇게 돌렸는데, 그러면 개발 브랜치를
빌드한 것이 그대로 사용자에게 나간다 — `main`이 프로덕션이라는 규율이 무너진다.
`PIZZART-play` 워크트리를 **태그에 고정해 두고 거기서 빌드해 돌린다.** 그래서 개발 쪽을
아무리 고쳐도 공개 중인 판은 흔들리지 않는다.

포트를 8080이 아니라 8090으로 둔 이유도 그것이다. 개발 서버가 8080을 쓰므로,
같이 쓰면 개발하는 순간 공개가 죽는다.

### 띄우는 법

```bash
# 공개 (pizzagame.app) — 터미널 둘
cd ~/pi22a/PIZZART-play && git checkout v1.6.1 && npm run build && PORT=8090 npm start
cloudflared tunnel run pizzart

# 개발 — 공개와 아무 상관 없이 돈다
cd ~/pi22a/PIZZART && npm run dev
```

### 새 버전을 공개에 올리는 법

```bash
cd ~/pi22a/PIZZART-play
git fetch && git checkout <새태그>   # 예: v1.6.2
npm run build
# PORT=8090 npm start 를 다시 띄운다 (Ctrl+C 후 재실행)
```

**사람이 없을 때 올린다.** 방 상태가 메모리에만 있어서 재시작하면 돌던 판이 날아간다.

### 이름 붙인 터널 만든 방법 (한 번만 하면 된다)

```bash
cloudflared tunnel login                       # 브라우저에서 pizzagame.app 승인
cloudflared tunnel create pizzart                # ~/.cloudflared/<UUID>.json 이 생긴다
cloudflared tunnel route dns pizzart pizzagame.app   # CNAME 자동 생성
# ~/.cloudflared/config.yml 작성 → deploy/tunnel-config.example.yml 참조
cloudflared tunnel ingress validate            # OK 나와야 한다
```

`login`은 **브라우저 승인이 끝날 때까지 그 프로세스가 살아 있어야 한다.** 중간에 죽으면
승인은 되었는데 인증서를 받아 적을 곳이 없어 `cert.pem`이 안 생긴다(실제로 겪었다).

임시 터널(`--tunnel`, `trycloudflare.com`)과 달리 **주소가 안 바뀐다.** 친구에게 한 번
보낸 주소가 계속 유효하고, PWA를 설치해 둬도 그대로 열린다.

### 서버로 옮길 때

바꿀 것은 앞단뿐이다. `npm run build && npm start`는 서버에서도 똑같고, 터널을 서버에서
돌리거나 Caddy로 바꾸면 된다. **애플리케이션 쪽은 손댈 것이 없다.**

`PIZZART-play`는 `.git`을 공유하는 워크트리다. 개발하면서 동시에 안정된 판을 띄우려고
만들었다. **이 구조가 그대로 스테이징이 된다** — 서버로 옮겨도 하는 일은 같다:
"이 태그를 배포한다".

---

## 서버로 옮기기 (AWS Lightsail)

지금은 `pizzagame.app`이 노트북을 가리킨다. 24시간 열어두려면 서버가 필요하다 —
Play의 12명 테스트도 그게 있어야 시작할 수 있다.

### 앞단은 Caddy가 아니라 터널로 간다

처음엔 Caddy를 적어뒀지만, 서버로 옮기는 지금은 **터널을 그대로 서버에 옮기는 쪽이
낫다.** 이유는 셋이다.

1. **이미 되는 것을 옮기기만 하면 된다.** 노트북에서 검증이 끝났다.
2. **열어둘 포트가 없다.** 터널은 서버가 밖으로 나가서 붙는다. Lightsail 방화벽에서
   SSH만 남기고 전부 닫아도 된다. 서버 IP가 노출되지 않는다.
3. **인증서를 다룰 일이 없다.** TLS는 Cloudflare가 맡는다. Let's Encrypt 갱신,
   Cloudflare 프록시와 인증서 발급이 부딪히는 문제 같은 것이 아예 안 생긴다.

Caddy 설정은 아래에 남겨두지만, 터널을 쓰면 필요 없다.

### ⚠️ 터널을 두 곳에서 돌리지 말 것

**가장 조심할 것이다.** 같은 터널을 노트북과 서버에서 동시에 돌리면 Cloudflare가 둘로
**나눠 보낸다.** 이 게임은 방 상태가 각 서버 메모리에만 있으므로, 친구는 A 서버 방에
있고 나는 B 서버 방에 들어가 **같은 방 코드인데 서로 안 보이는** 일이 벌어진다.
원인을 찾기가 아주 어려운 종류다.

서버에서 켜기 전에 **노트북 쪽을 반드시 끈다.**

### 한 대만 돌린다

같은 이유로 서버를 여러 대로 늘리지 못한다. 방이 메모리에 있어서다. 4~9명짜리 방
수십 개는 512MB 한 대로 충분하다.

### 겪은 것 두 가지 (다시 배포할 때를 위해)

**`226/NAMESPACE`로 서비스가 안 떴다.** `ReadWritePaths=.../data`를 넣어뒀는데 `data/`는
`.gitignore`라 새로 clone한 서버에 없었다. 그 목록은 **프로세스가 시작되기 전에** systemd가
확인하므로 코드가 돌아보지도 못하고 죽는다. 만들어주려고 `ExecStartPre=mkdir`을 넣었더니
**그것조차 같은 검사에 걸려** 못 돌았다. `ProtectSystem=full`은 `/usr`·`/boot`·`/etc`만
읽기 전용으로 만들고 `/home`은 그대로 두므로 `ReadWritePaths` 자체가 필요 없는 줄이었다 —
지웠다.

**노트북 터널이 켜져 있었다.** 서버로 옮기기 직전에 확인했더니 돌고 있었다. 그대로
서버 것을 켰으면 Cloudflare가 둘로 나눠 보내 방이 갈렸을 것이다. **옮기기 전에 반드시
확인한다.**

```bash
pgrep -fl "cloudflared tunnel"     # 아무것도 안 나와야 한다
```

### 순서

**1. 인스턴스 만들기** (Lightsail 콘솔)

| | |
|---|---|
| 리전 | **서울 (ap-northeast-2)** — 노는 사람이 한국에 있다 |
| 이미지 | Linux/Unix → **Ubuntu 24.04 LTS** |
| 요금제 | $5 (512MB)로 충분하다. 빌드가 빠듯하면 스왑이 받쳐준다(스크립트가 만든다) |
| 키 | SSH 키를 새로 만들어 받아둔다 → `../PIZZART-release/keys/` |

**2. 방화벽 조이기** — Networking 탭에서 **SSH(22)만 남기고 HTTP/HTTPS 규칙을 지운다.**
터널은 나가는 연결만 쓰므로 들어오는 문을 열 필요가 없다.

**3. 배포 키 등록** — 저장소가 비공개라 서버가 그냥 못 받아온다.

```bash
ssh -i <키> ubuntu@<서버IP>
ssh-keygen -t ed25519 -C "pizzart-deploy" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

나온 값을 GitHub → 저장소 → Settings → Deploy keys → **Add deploy key**(쓰기 권한 없이)에 넣는다.

**4. 세팅 스크립트**

```bash
curl -O https://raw.githubusercontent.com/... # 또는 scp로 deploy/setup-server.sh 전송
bash setup-server.sh
```

스왑 → Node → 저장소(최신 태그) → 빌드 → 서비스 등록까지 한다. 끝나면 확인:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8090/    # 200 이어야 한다
```

**5. 터널을 서버로 옮기기**

노트북의 자격 증명을 서버로 복사한다. 터널을 새로 만들 필요가 없다 — 같은 터널이다.

```bash
# 노트북에서
scp -i <키> ~/.cloudflared/<터널UUID>.json ubuntu@<서버IP>:~/
scp -i <키> ~/.cloudflared/config.yml ubuntu@<서버IP>:~/

# 서버에서
sudo mkdir -p /etc/cloudflared
sudo mv ~/<터널UUID>.json ~/config.yml /etc/cloudflared/
sudo sed -i 's|/Users/imiyeon/.cloudflared|/etc/cloudflared|' /etc/cloudflared/config.yml
# cloudflared 설치 (arm64 인스턴스면 arm64로 받는다)
curl -L -o cf.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cf.deb
sudo cloudflared service install
sudo systemctl status cloudflared
```

**6. 노트북 터널 끄기** — 위 경고 참조. 이걸 안 하면 방이 갈린다.

**7. 확인**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://pizzagame.app/
```

### 새 버전 올리기

```bash
ssh ubuntu@<서버IP>
cd ~/PIZZART && git fetch --tags && git checkout <새태그>
npm ci && npm run build
sudo systemctl restart pizzart
```

**사람이 없을 때 한다.** 재시작하면 돌던 판이 전부 날아간다.

### 되돌리기

```bash
cd ~/PIZZART && git checkout <이전태그> && npm ci && npm run build
sudo systemctl restart pizzart
```

---

## 브랜치와 태그

지금까지는 개발 브랜치(`v1.6`)에서 계속 작업하고 `main`은 뒤처져 있었다. 지인 테스트만
할 때는 문제가 없었지만, **출시하면 `main`이 프로덕션이어야 한다.**

| | 뜻 |
|---|---|
| `main` | **지금 서버에 떠 있는 것.** 여기 있는 것 = 사용자가 쓰는 것 |
| `vN.N` | 개발 브랜치. 다음 버전을 만드는 곳 |
| 태그 `vN.N.N` | 릴리스한 시점. 롤백 지점 |
| `release/N.N` | 그 버전에서 급한 것만 고칠 때 |

### 릴리스 끊는 순서

```bash
# 1. 개발 브랜치에서 마무리 — 테스트가 전부 통과해야 한다
npm test

# 2. CHANGELOG의 "미출시" 머리를 버전과 날짜로 바꾼다
#    무엇을 왜 바꿨는지가 적혀 있어야 한다. 목록만 있는 것은 쓸모가 없다

# 3. main으로 합치고 태그
git checkout main
git merge --no-ff v1.6
git tag v1.6.0
git push origin main --tags

# 4. 다음 개발 브랜치를 딴다
git checkout -b v1.7
```

---

## 프로덕션 빌드

빌드는 이미 된다. 프레임워크가 없어서 결과물이 아주 작다.

```bash
npx vite build     # → dist/
```

```
dist/index.html                32 kB │ gzip 10.6 kB
dist/assets/index-*.js       40.5 kB │ gzip 14.6 kB
```

**서버가 화면까지 같이 낸다.** `dist/`가 있으면 게임 서버가 그것을 그대로 서빙하고,
웹소켓도 같은 포트에서 받는다. 프로덕션에서 Vite는 안 돈다 — 개발 서버는 고칠 때마다
다시 읽고 모듈을 쪼개 보내는 물건이라 그 자리에 둘 것이 아니다.

```bash
npm run build     # dist/ 를 만든다
npm start         # 화면과 게임을 한 포트(기본 8080)에서 낸다
```

개발 중에는 `dist/`가 없으므로 이 기능이 저절로 꺼지고 Vite가 화면을 맡는다.

덕분에 **관리할 프로세스가 하나뿐이다.** 앞에 세우는 것(Caddy든 Cloudflare 터널이든)은
TLS만 맡고 전부 이 포트로 넘기면 된다.

### 앞단은 둘 중 하나

**(가) Cloudflare 터널** — 서버 없이 지금 당장. 도메인이 Cloudflare에 있으므로 이름 붙인
터널을 만들면 `pizzagame.app`이 내 컴퓨터를 가리킨다. 공짜고, 포트를 열 필요가 없고,
HTTPS는 Cloudflare가 맡는다. **단점은 컴퓨터가 켜져 있어야 한다는 것** — 24시간 서비스로는
못 쓰고, Play의 12명 테스트 기간에도 부족하다. 진짜 서버로 옮기기 전의 발판이다.

**(나) 서버 + Caddy** — 24시간. 아래가 그 설정이다.

### 왜 Caddy인가

- 인증서를 알아서 받아오고 갱신한다 (무료, 설정 두 줄)
- 정적 파일과 웹소켓 프록시를 한 번에 한다
- ALB는 그것만 월 $16이라 배보다 배꼽이다

```
pizzagame.app {
    # 게임 서버로 넘긴다. 클라이언트가 wss://<현재 호스트>/ws 로 붙으므로
    # 이 경로만 맞으면 코드는 안 고쳐도 된다.
    reverse_proxy /ws* localhost:8080

    # 나머지는 빌드 결과물
    root * /srv/pizzart/dist
    file_server

    # TWA가 주소창을 감추려면 이 파일이 있어야 한다. 도메인이 앱을 인정한다는 증명서다.
    # Caddy는 점으로 시작하는 폴더를 기본으로 숨기므로 명시해 준다.
    handle /.well-known/assetlinks.json {
        root * /srv/pizzart/well-known
        file_server
    }
}

staging.pizzagame.app {
    reverse_proxy /ws* localhost:8081
    root * /srv/pizzart-staging/dist
    file_server
    # assetlinks를 두지 않는다. 앱이 스테이징으로 끌려가면 안 된다.
    basic_auth {
        # 지인만 들어오게. 비밀번호 해시는 `caddy hash-password`로 만든다
    }
}
```

프로덕션과 스테이징이 **각각 다른 게임 서버 포트**(8080/8081)를 본다. 지금 노트북에서
쓰던 그 구조 그대로다.

**중요** — 클라이언트는 페이지와 같은 호스트의 `/ws`로 붙는다(`src/client/net.ts`).
그래서 도메인이 정해지면 코드 수정이 필요 없다. 대신 이 프록시 경로가 어긋나면
게임이 통째로 안 붙는다.

---

## 서버

Lightsail $5 요금제 하나면 충분하다. 근거는 실측이다 — 한 판 9명이 10MB 남짓이라
포함된 전송량 1TB로 한 달 5만 판을 돈다.

### 배포할 때 알아야 할 것

**서버를 재시작하면 진행 중인 판이 전부 날아간다.** 방 상태가 메모리에만 있기 때문이다
(`Map<string, Session>`). 지인들끼리 할 때는 "잠깐만"이면 됐지만 모르는 사람이 쓰기
시작하면 비용이 된다.

당분간의 규칙은 이것으로 충분하다 — **사람 없을 때 배포한다.** 방이 다 빈 것을 보고
올린다. 나중에 정말 문제가 되면 그때 방 상태를 밖으로 빼는 것을 고민한다.

### 롤백

태그를 찍어두는 이유가 이것이다.

```bash
git checkout v1.5.1
npx vite build
# dist/를 서버에 다시 올린다. 서버 프로세스도 그 버전으로 재시작
```

---

## 배포 전 점검

- [ ] `npm test` 전부 통과
- [ ] `npx tsc --noEmit` 오류 없음
- [ ] `npx vite build` 성공
- [ ] CHANGELOG에 이번 버전이 **왜** 바뀌었는지 적혀 있다
- [ ] 폰 크기(375px)에서 확인했다 — 테스터 대부분이 폰이다
- [ ] 밝은 모드와 어두운 모드 둘 다 확인했다
- [ ] 방이 비어 있다 (진행 중인 판을 끊지 않는다)

---

## 스토어 출시 (아직 안 함)

웹앱을 Play에 올리려면 **TWA**로 감싼다. 크롬 엔진으로 사이트를 주소창 없이 띄우는
얇은 안드로이드 앱이고, 게임 코드는 한 줄도 안 들어간다. `PWABuilder`나 `Bubblewrap`에
도메인을 주면 만들어 준다.

### 먼저 있어야 하는 것

1. **고정 도메인 + HTTPS + 24시간 도는 서버** — 위 참조. 임시 터널 주소로는 안 된다
2. **PWA 요건** — `manifest.webmanifest`, 아이콘 192·512, 서비스 워커
3. **`/.well-known/assetlinks.json`** — 도메인이 이 앱을 인정한다는 증명서.
   빠뜨리면 앱 안에 주소창이 남는다. 안에 들어가는 지문(SHA-256)은 **서명 키**에서
   나오므로, 키를 만든 뒤에야 이 파일을 만들 수 있다 → `../PIZZART-release/keys/`

   ```
   https://pizzagame.app/.well-known/assetlinks.json
   ```

### 서비스 워커에 함정이 있다

이 게임은 실시간 멀티플레이라 **오프라인 플레이가 의미가 없다.** 그런데 TWA에서 인터넷이
끊기면 앱 안에 크롬 오류 페이지가 뜨고, 사용자 눈에는 앱이 고장 난 것으로 보인다.

그래서 워커는 캐싱용이 아니라 **"인터넷 연결이 필요합니다"를 대신 띄우는 용도**로 짠다.

### Play 쪽 절차

- 개발자 등록 **$25** (일회성)
- 개인정보처리방침 URL, 데이터 안전 양식, 콘텐츠 등급 설문
- **개인 계정(2023-11-13 이후 생성)은 테스터 12명이 14일 연속 참여**해야 프로덕션에
  올릴 수 있다. 우회로가 없고 앱마다 시계가 새로 돈다. 심사까지 **한 달**은 잡는다.
  사업자 계정은 면제다.

역설적으로 이 게임에는 유리하다. 어차피 4~9명이 모여야 하는 파티 게임이라
테스터 12명을 모으기가 남들보다 쉽다.

### 곁들여 넣으면 좋은 것

- **뒤로가기 처리** — 안드로이드 뒤로가기를 누르면 방에서 나가는 게 아니라 앱이 꺼진다
- **화면 꺼짐 방지** — 그리는 시간이 120초라 그동안 폰 화면이 꺼진다 (Wake Lock)

---

## 순서 제안

| | 할 일 | 막는 것 |
|---|---|---|
| 0 | 도메인 등록 (`pizzagame.app`) | — **끝나야 아래가 진행된다** |
| 1 | 서버 준비 + Caddy + DNS + 배포 | 도메인 |
| 2 | PWA 만들기 (manifest·서비스 워커·아이콘) | **없음 — 지금 바로 가능** |
| 3 | TWA로 감싸 Play에 | 1·2 + 서명 키 |

**2번은 도메인을 기다릴 필요가 없다.** manifest와 서비스 워커는 상대 경로로 쓰면
어느 주소에서든 그대로 동작한다. 도메인을 사는 동안 이걸 먼저 해두면 된다.

여기까지 오면 도메인 없이도 얻는 것이 있다 — **2번만 끝나도 지금 터널 주소로 지인들이
홈 화면에 깔아 쓸 수 있다.** 스토어 심사도, $25도, 12명 테스트도 필요 없다.

1·2단계는 실제 코드 작업이 반나절쯤이다. 3단계는 코드보다 서류가 대부분이다.
