/**
 * 주제 파일들과 규칙을 한 파일로 합친다. 유니티가 Resources/에 그냥 떨궈 쓰기 위한 것이다.
 *
 *   node scripts/bundle-content.mjs
 *
 * 원본은 여전히 content/words/*.json 이다. 이 합친 파일은 만들어지는 것이므로
 * 주제나 단어를 고쳤으면 이걸 다시 돌려야 한다.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wordsDir = join(root, 'content', 'words');

const rules = JSON.parse(readFileSync(join(root, 'content', 'rules.json'), 'utf8'));
const topics = readdirSync(wordsDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(wordsDir, f), 'utf8')));

const total = topics.reduce((n, t) => n + t.words.length, 0);
const out = {
  note: 'content/words/*.json 과 rules.json 에서 만들어진 파일이다. 직접 고치지 말 것 — scripts/bundle-content.mjs 를 돌린다.',
  builtAt: new Date().toISOString().slice(0, 10),
  rules,
  topics,
};
writeFileSync(join(root, 'content', 'pizzart-content.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`주제 ${topics.length}개 · 제시어 ${total}개 → content/pizzart-content.json`);
for (const t of topics) console.log(`  ${t.topic} ${t.words.length}개`);
