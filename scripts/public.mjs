/**
 * 공개 인스턴스를 한 번에 띄운다.
 *
 *   node scripts/public.mjs [--port 8090] [--no-tunnel]
 *
 * 하는 일 세 가지 — 빌드, 서버, 터널. 터미널 하나에서 끝나고 Ctrl+C 한 번에 셋 다 내려간다.
 *
 * **빌드를 먼저 끝내고 서버를 띄우는 순서가 중요하다.** 서버는 시작할 때 dist/가 있는지
 * 보고 화면을 낼지 말지 정한다(src/server/static.ts). 빌드가 아직 안 끝났는데 서버가
 * 뜨면 그 판단이 '없음'으로 굳어서, 빌드가 끝나도 화면이 안 나가고 404만 준다.
 *
 * 개발용 serve.mjs와 따로 둔 이유: 하는 일이 다르다. 저쪽은 고칠 때마다 다시 읽는
 * Vite를 띄우고, 이쪽은 빌드된 것을 그대로 낸다. 한 파일에 섞으면 양쪽 다 읽기 어려워진다.
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const bin = (name) => join(root, 'node_modules', '.bin', win ? `${name}.cmd` : name);

const args = process.argv.slice(2);
const at = args.indexOf('--port');
const PORT = at >= 0 ? args[at + 1] : '8090';
const wantTunnel = !args.includes('--no-tunnel');

const kids = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const k of kids) k.kill('SIGTERM');
  setTimeout(() => process.exit(code), 200);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop(0));

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
      for (const line of lines) out.write(tag + line + '\n');
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
    console.error(`${tag}끝났습니다 (코드 ${code}). 나머지도 내립니다.`);
    stop(code ?? 1);
  });
  kids.push(kid);
  return kid;
}

/** 빌드는 끝날 때까지 기다린다. 위 주석의 순서 문제 때문이다. */
function build() {
  return new Promise((res, rej) => {
    console.log('\x1b[36m[빌드]\x1b[0m 화면을 만드는 중…');
    const kid = spawn(bin('vite'), ['build'], { cwd: root, shell: win, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    kid.stdout.on('data', (c) => { out += c; });
    kid.stderr.on('data', (c) => { out += c; });
    kid.on('exit', (code) => {
      if (code === 0) {
        const size = out.match(/index-[\w-]+\.js\s+([\d.]+ kB[^\n]*)/);
        console.log(`\x1b[36m[빌드]\x1b[0m 끝났습니다${size ? ` — ${size[1].trim()}` : ''}`);
        res();
      } else {
        console.error(out);
        rej(new Error(`빌드 실패 (코드 ${code})`));
      }
    });
    kid.on('error', rej);
  });
}

try {
  await build();
} catch (e) {
  console.error(`\x1b[31m${e.message}\x1b[0m`);
  process.exit(1);
}

run('서버', '36', process.execPath, ['--import', 'tsx', 'src/server/index.ts'], { env: { PORT, NODE_ENV: 'production' } });

if (wantTunnel) {
  // 이름 붙인 터널이라 주소가 고정이다. cloudflared는 따로 깔아 쓰는 것이라 PATH에서 찾는다.
  run('터널', '33', 'cloudflared', ['tunnel', 'run', 'pizza'], { optional: true });
}

console.log(`\n  공개  ${wantTunnel ? 'https://pizzagame.app' : '(터널 없음)'}   내 컴퓨터  http://localhost:${PORT}`);
if (wantTunnel) {
  console.log('  \x1b[31m터널을 서버에서도 돌리고 있다면 먼저 끄세요 — 방이 둘로 갈립니다\x1b[0m');
}
console.log('  Ctrl+C 한 번이면 전부 내려갑니다\n');
