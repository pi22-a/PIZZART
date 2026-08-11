# PIZZA

4~9명이 즐기는 웹 협동 추리 게임.

한 명이 제시어를 보고 **원형 캔버스**에 그림을 그린다. 그 그림은 **피자처럼 부채꼴로 잘려**
나머지에게 한 조각씩 흩어진다. 모든 조각은 **둥근 쪽이 위로 오게 회전되어** 있어서
자기 조각이 원본의 어느 방향이었는지 아무도 모른다.

통화로 조각을 설명해가며 제시어를 맞힌다. **음성은 게임 안에 없다.**
디스코드나 카톡 통화를 켜놓고 하는 것을 전제로 만들었다.

## 실행

```bash
npm install     # 처음 한 번만
npm run dev
```

명령 하나로 게임 서버(8080)와 페이지 서버(5173)가 함께 뜬다. 끄려면 `Ctrl + C` 한 번.

```
http://localhost:5173/?room=아무거나
```

같은 방 코드를 쓰는 사람끼리 만난다. **4명 이상**이어야 시작할 수 있다.
`?name=이름`을 붙이면 이름을 묻지 않는다.

게임이 이미 진행 중이면 3명까지 계속 진행할 수 있다.

## 밖에서 접속하기

```bash
npm run tunnel
```

나온 주소를 그대로 보내면 된다. https라 wss가 자동으로 따라간다.

## 인원이 모자랄 때

```bash
node scripts/fake-player.mjs 방코드 봇1 --draw --answer=피자 --skip
```

## 규칙 조절

`content/rules.json`의 값을 바꾸고 서버만 재시작한다.

| 값 | 뜻 |
|---|---|
| `sliceCountMin` | 조각 수의 최솟값. 맞히는 사람이 더 많으면 인원에 맞춰 늘어난다 |
| `drawSeconds` | 그리는 시간 |
| `guessSeconds` | 시도 한 번의 추론 시간 |
| `maxAttempts` | 라운드당 시도 횟수 |
| `attemptPoints` | 시도 회차별 점수 |
| `drawerPointPerCorrect` | 출제자가 맞힌 사람 1명당 받는 점수 |

단어를 늘리려면 `content/words/`에 JSON을 하나 더 넣는다.

```json
{ "topic": "직업", "words": ["의사", "소방관"] }
```

## 테스트

```bash
npm test
```

## 설계 문서

- [설계](docs/superpowers/specs/2026-08-10-pizza-design.md)
- [구현 계획](docs/superpowers/plans/2026-08-10-pizza-mvp.md)
