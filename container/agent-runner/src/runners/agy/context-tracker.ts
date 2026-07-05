/**
 * agy 上下文规模估算。
 *
 * agy print 模式不输出 usage，但 conversation SQLite 库里的 gen_metadata
 * 表按 step 存了模型调用的 usage protobuf。逆向得到的字段路径：
 *   gen_metadata.data -> field 1 (message) -> field 4 (usage message)
 *     -> field 2 (varint) = 本次请求 prompt tokens
 * 会话内混有小型辅助调用（标题生成、命令安全检查等），因此取全表
 * **最大值** 作为当前主 agent 上下文规模（实测严格随主对话单调增长，
 * 已在 14.5 万 tokens 的真实会话上验证 93/93 行全部可解码）。
 *
 * 解码失败时回落到 steps.step_payload 字节数 / 4 的粗估（偏保守，
 * 会提早触发压缩，方向安全）。
 */

import fs from 'fs';
import path from 'path';

import { agyStateDir } from './agy-env.js';

export interface AgyContextEstimate {
  tokens: number;
  method: 'gen_metadata' | 'payload_bytes';
}

/** 读 varint；shift 超过 49 位的大数直接放弃（我们只关心小整数字段）。 */
function readVarint(
  buf: Uint8Array,
  pos: number,
): { value: number | null; next: number } | null {
  let result = 0;
  let shift = 0;
  let overflow = false;
  while (pos < buf.length) {
    const byte = buf[pos];
    pos += 1;
    if (shift > 49) {
      overflow = true;
    } else {
      result |= (byte & 0x7f) * 2 ** shift;
    }
    if ((byte & 0x80) === 0) {
      return { value: overflow ? null : result, next: pos };
    }
    shift += 7;
  }
  return null;
}

/** 在一个 protobuf message 里找指定 field：wire=2 返回子串，wire=0 返回数值。 */
function findField(
  buf: Uint8Array,
  target: number,
): { varint?: number; bytes?: Uint8Array } | null {
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    if (!tag || tag.value === null) return null;
    pos = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      if (!v) return null;
      pos = v.next;
      if (field === target && v.value !== null) return { varint: v.value };
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      if (!len || len.value === null) return null;
      pos = len.next;
      if (pos + len.value > buf.length) return null;
      if (field === target) return { bytes: buf.subarray(pos, pos + len.value) };
      pos += len.value;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      return null;
    }
  }
  return null;
}

/** gen_metadata 行 -> prompt tokens（路径 f1 -> f4 -> f2）。 */
function extractPromptTokens(data: Uint8Array): number | null {
  const f1 = findField(data, 1);
  if (!f1?.bytes) return null;
  const f4 = findField(f1.bytes, 4);
  if (!f4?.bytes) return null;
  const f2 = findField(f4.bytes, 2);
  return typeof f2?.varint === 'number' ? f2.varint : null;
}

interface SqliteRow {
  [key: string]: unknown;
}

/**
 * 估算指定会话当前的上下文 tokens。
 * 读取失败（node:sqlite 不可用、DB 缺失、schema 变化）返回 null，调用方跳过检查。
 */
export async function estimateAgyContextTokens(
  homeDir: string,
  conversationId: string,
  scratchDir: string,
): Promise<AgyContextEstimate | null> {
  const srcBase = path.join(
    agyStateDir(homeDir),
    'conversations',
    `${conversationId}.db`,
  );
  if (!fs.existsSync(srcBase)) return null;

  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    return null;
  }

  // 复制 db + wal/shm 后再打开：避免与偶发未退净的 agy 进程争锁，
  // 也允许 sqlite 在副本上做 WAL 恢复
  const probeBase = path.join(scratchDir, 'ctx-probe.db');
  const cleanupFiles: string[] = [];
  try {
    for (const ext of ['', '-wal', '-shm']) {
      const src = `${srcBase}${ext}`;
      const dst = `${probeBase}${ext}`;
      try {
        fs.rmSync(dst, { force: true });
      } catch {
        /* ignore */
      }
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        cleanupFiles.push(dst);
      }
    }

    const db = new sqlite.DatabaseSync(probeBase);
    try {
      let maxTokens = 0;
      for (const row of db
        .prepare('SELECT data FROM gen_metadata')
        .all() as SqliteRow[]) {
        const data = row.data;
        if (!(data instanceof Uint8Array)) continue;
        const tokens = extractPromptTokens(data);
        if (tokens !== null && tokens > maxTokens) maxTokens = tokens;
      }
      if (maxTokens > 0) {
        return { tokens: maxTokens, method: 'gen_metadata' };
      }
      const payload = db
        .prepare(
          'SELECT COALESCE(SUM(LENGTH(step_payload)), 0) AS bytes FROM steps',
        )
        .get() as SqliteRow;
      const bytes = typeof payload?.bytes === 'number' ? payload.bytes : 0;
      if (bytes > 0) {
        return { tokens: Math.round(bytes / 4), method: 'payload_bytes' };
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  } finally {
    for (const file of cleanupFiles) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
