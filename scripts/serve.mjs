/**
 * 게임 서버와 화면 서버를 한 쌍으로 띄운다. 포트를 인자로 받는다.
 *
 * 왜 셸에서 바로 안 하는가: 포트를 넘기려면 환경변수를 써야 하는데
 * `PORT=8081 tsx ...`는 cmd.exe에서 안 먹는다. 여기서 넘기면 어디서든 같다.
 *
 *   node scripts/serve.mjs <화면포트> <게임포트>
 *
 * 두 쌍을 동시에 띄울 수 있다는 것이 요점이다 — 한쪽은 친구들이 놀고 있는
 * 안정된 판, 다른 한쪽은 지금 고치고 있는 판.
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 실행 파일을 node_modules/.bin에서 직접 찾는다.
 *
 * npm이 스크립트를 돌릴 때는 PATH에 그 자리를 끼워주지만, 이 파일을 `node`로 바로
 * 부르면 그 도움이 없다. 이름만 넘기면 "tsx를 못 찾겠다"로 끝난다.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = (name) => join(root, 'node_modules', '.bin', name);

const web = Number(process.argv[2] ?? 5173);
const game = Number(process.argv[3] ?? 8080);

if (!Number.isInteger(web) || !Number.isInteger(game)) {
  console.error('쓰는 법: node scripts/serve.mjs <화면포트> <게임포트>');
  process.exit(1);
}

const kids = [];

function run(label, color, cmd, args, env) {
  // npm 자체가 아니라 node_modules/.bin의 실행 파일을 부른다.
  // 윈도우에서는 .cmd 확장자가 붙고 셸을 거쳐야 한다.
  const win = process.platform === 'win32';
  const kid = spawn(win ? `${bin(cmd)}.cmd` : bin(cmd), args, {
    cwd: root,
    env: { ...process.env, ...env },
    shell: win,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `\x1b[${color}m[${label}]\x1b[0m `;
  const pipe = (stream, out) => {
    stream.setEncoding('utf8');
    let rest = '';
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) out.write(tag + line + '\n');
    });
  };
  pipe(kid.stdout, process.stdout);
  pipe(kid.stderr, process.stderr);
  // 한쪽이 죽으면 다른 쪽도 내린다. 반쪽만 살아 있으면 화면은 뜨는데 판이 안 돌아
  // "왜 안 되지"로 시간을 버린다.
  kid.on('exit', (code) => {
    if (!stopping) {
      console.error(`${tag}끝났습니다 (코드 ${code}). 나머지도 내립니다.`);
      stop(code ?? 1);
    }
  });
  kids.push(kid);
  return kid;
}

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const k of kids) k.kill('SIGTERM');
  setTimeout(() => process.exit(code), 200);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(0));

run('서버', '36', 'tsx', ['src/server/index.ts'], { PORT: String(game) });
run('화면', '35', 'vite', ['--port', String(web), '--strictPort'], {
  // 화면 서버가 /ws 를 어느 게임 서버로 넘길지. 두 쌍이 서로 남의 판에
  // 끼어들지 않으려면 이 짝이 맞아야 한다.
  PIZZA_SERVER: `ws://localhost:${game}`,
});

console.log(`\n  화면 http://localhost:${web}   게임 ws://localhost:${game}\n`);
