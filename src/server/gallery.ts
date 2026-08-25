import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DrawingRecord } from './session';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, 'data');
const file = join(dir, 'drawings.jsonl');

/**
 * 그림을 한 줄씩 파일에 쌓는다.
 *
 * 한 줄에 한 판(JSON Lines). 통째로 읽어 고치는 형식을 쓰면 판이 도는 중에
 * 파일 전체를 다시 쓰게 되고, 그러다 서버가 죽으면 모아둔 것이 통째로 날아간다.
 * 이어붙이기만 하면 마지막 줄 하나만 잃는다.
 *
 * 쓰다 실패해도 판은 계속 간다. 그림을 모으는 것은 게임의 조건이 아니다.
 */
export function saveDrawing(rec: DrawingRecord): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    console.error('[그림 저장 실패]', e);
  }
}

export const drawingsPath = file;
