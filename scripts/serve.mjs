/**
 * 한 판에 필요한 것을 한 터미널에서 전부 띄운다.
 *
 *   node scripts/serve.mjs <화면포트> <게임포트> [--tunnel] [--watch]
 *
 * 포트를 인자로 받는 이유: 두 쌍을 동시에 띄울 수 있어야 한다. 한쪽은 친구들이
 * 놀고 있는 안정된 판, 다른 한쪽은 지금 고치고 있는 판. 포트가 갈려 있으면 서로
 * 아무 상관이 없어서, 고치는 쪽을 저장해도 노는 쪽 브라우저가 안 흔들린다.
 *
 * 셸에서 바로 안 하는 이유: 포트를 넘기려면 환경변수를 써야 하는데
 * `PORT=8081 tsx ...`는 cmd.exe에서 안 먹는다. 여기서 넘기면 어디서든 같다.
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
const win = process.platform === 'win32';
const bin = (name) => join(root, 'node_modules', '.bin', win ? `${name}.cmd` : name);

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const nums = args.filter((a) => !a.startsWith('--')).map(Number);
const web = Number.isInteger(nums[0]) ? nums[0] : 5173;
const game = Number.isInteger(nums[1]) ? nums[1] : 8080;
const wantTunnel = flags.includes('--tunnel');
const wantWatch = flags.includes('--watch');

const kids = [];
let stopping = false;

/**
 * @param optional 이게 죽어도 나머지는 살려둔다. 터널이 그렇다 —
 *   cloudflared가 없거나 끊겨도 판은 계속 돌아야 한다.
 */
function run(label, color, exe, argv, { env, optional } = {}) {
  const kid = spawn(exe, argv, {
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
      for (const line of lines) {
        out.write(tag + line + '\n');
        // 터널 주소는 상자 그림 안에 묻혀 나온다. 친구에게 보낼 그 한 줄만 따로 크게 띄운다.
        const url = line.match(/https:\/\/[^\s|]+\.trycloudflare\.com/);
        if (url) console.log(`\n  \x1b[32m친구에게 보낼 주소 → ${url[0]}\x1b[0m\n`);
      }
    });
  };
  pipe(kid.stdout, process.stdout);
  pipe(kid.stderr, process.stderr);

  kid.on('error', (e) => {
    console.error(`${tag}띄우지 못했습니다: ${e.message}`);
    if (!optional) stop(1);
  });
  kid.on('exit', (code) => {
    if (stopping) return;
    if (optional) {
      console.error(`${tag}끝났습니다 (코드 ${code}). 판은 계속 돕니다.`);
      return;
    }
    // 반쪽만 살아 있으면 화면은 뜨는데 판이 안 돌아 "왜 안 되지"로 시간을 버린다.
    console.error(`${tag}끝났습니다 (코드 ${code}). 나머지도 내립니다.`);
    stop(code ?? 1);
  });
  kids.push(kid);
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const k of kids) k.kill('SIGTERM');
  setTimeout(() => process.exit(code), 200);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(0));

run('서버', '36', bin('tsx'),
  wantWatch ? ['watch', 'src/server/index.ts'] : ['src/server/index.ts'],
  { env: { PORT: String(game) } });

run('화면', '35', bin('vite'), ['--port', String(web), '--strictPort'], {
  // 화면 서버가 /ws 를 어느 게임 서버로 넘길지. 두 쌍이 서로 남의 판에
  // 끼어들지 않으려면 이 짝이 맞아야 한다.
  env: { PIZZART_SERVER: `ws://localhost:${game}` },
});

if (wantTunnel) {
  // cloudflared는 따로 깔아 쓰는 것이라 node_modules에 없다. PATH에서 찾는다.
  run('터널', '33', 'cloudflared', ['tunnel', '--url', `http://localhost:${web}`], { optional: true });
}

console.log(`\n  화면 http://localhost:${web}   게임 ws://localhost:${game}`);
if (!wantTunnel) console.log('  (밖에서 들어오게 하려면 --tunnel)');
console.log('');
