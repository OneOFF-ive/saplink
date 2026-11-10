import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { z } from 'zod';
import type { ModelTool } from './model/model.js';
import { estimateTokens } from './model/token-estimate.js';

const candidate = z.strictObject({
  kind: z.enum(['preference', 'lesson']),
  scope: z.enum(['profile', 'connection']).optional(),
  topic: z.string().trim().min(2).max(80),
  note: z.string().trim().min(2).max(400),
  evidence: z.string().trim().min(2).max(160),
});
export const memoryInput = z.strictObject({ entries: z.array(candidate).min(1).max(3) });
const record = candidate.omit({ evidence: true }).extend({
  task_id: z.uuid(),
  created_at: z.iso.datetime(),
  evidence_artifact: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
const searchLimit = 128;
const memoryTokenBudget = 1800;
const preferenceTokenBudget = 500;
const profileNamespace = 'profile';
export const recalledMemoriesSchema = z.array(record).max(searchLimit * 2);
export type MemoryRecord = z.infer<typeof record>;

export const memoryTool: ModelTool = {
  type: 'function',
  function: {
    name: 'remember_for_future',
    description: '保存可复用的偏好或 SAP 排查步骤，默认仅用于当前连接。用户用自己的话明确要求偏好跨系统长期生效时，可以为 preference 选择 scope=profile。evidence 必须是包含全局范围和偏好内容的当前用户原话，note 必须是其中的实际偏好原文。修改已有偏好时，沿用已有 topic 和 scope。引用、示例、询问格式或否定陈述都不能当作授权。lesson 仅限当前连接，evidence 是本轮成功读取的 SAP 源码或元数据附件编号。禁止保存源码、表数据、凭据、个人资料或写入授权。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['entries'],
      properties: {
        entries: {
          type: 'array', minItems: 1, maxItems: 3, items: {
            type: 'object', additionalProperties: false, required: ['kind', 'topic', 'note', 'evidence'],
            properties: {
              kind: { type: 'string', enum: ['preference', 'lesson'] },
              scope: { type: 'string', enum: ['profile', 'connection'] },
              topic: { type: 'string', minLength: 2, maxLength: 80 },
              note: { type: 'string', minLength: 2, maxLength: 400 },
              evidence: { type: 'string', minLength: 2, maxLength: 160 },
            },
          },
        },
      },
    },
  },
};

function normalize(text: string) {
  return text.normalize('NFKC').toLowerCase();
}

function searchTerms(text: string) {
  const words = normalize(text).match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}_])+/gu) ?? [];
  return words.flatMap(word => {
    if (!/^\p{Script=Han}/u.test(word)) return word.length >= 2 ? [word] : [];
    const characters = [...word];
    if (characters.length === 1) return characters;
    return characters.slice(0, -1).map((character, index) => character + characters[index + 1]);
  });
}

export function safeMemoryText(text: string) {
  return !/[\r\n]|https?:\/\/|\/(sap|bc)\/|(?:api[_ -]?key|password|密码|密钥)\s*[:=：]/i.test(text);
}

function safeProfileText(text: string) {
  return safeMemoryText(text) &&
    !/密码|密钥|口令|令牌|token|password|credential|生产写入|免审批|绕过审批/iu.test(text);
}

// The model identifies intent and topic. Only direct user evidence can authorize profile scope.
export function profileEvidenceMatches(prompt: string, evidence: string, topic: string, note: string) {
  const explicitScope = /全局|跨(?:所有)?\s*(?:SAP\s*)?(?:系统|连接)|(?:所有|每个|各个|任意|任何)\s*(?:SAP\s*)?(?:系统|连接)|(?:无论|不论|不管).{0,12}(?:系统|连接)/iu;
  const lastingIntent = /以后|今后|往后|长期|每次|默认|始终|都|一律|记住|偏好|改成|改为|更新|apply|always|remember/iu;
  const exampleOrQuestion = /例如|比如|示例|举例|假设|(?:引用|转述)(?:以下|这段|这句)|这个格式|什么格式|(?:怎么|如何)(?:写|设置)/u;
  const scopeDenied = /(?:不要|无需|不用|不能|别).{0,12}(?:全局|跨系统|跨连接|所有系统)/u;
  const startsWithQuote = /^[`"'“‘「『]/u.test(prompt.trimStart());
  return prompt.includes(evidence) && evidence.includes(note) &&
    explicitScope.test(evidence) && lastingIntent.test(evidence) &&
    !startsWithQuote && !exampleOrQuestion.test(prompt) && !scopeDenied.test(prompt) &&
    safeProfileText(topic + ' ' + evidence);
}

// Retain the explicit command for callers who supply an exact topic themselves.
export function explicitProfilePreference(prompt: string, taskId: string, createdAt: string) {
  const match = /^记住全局偏好\s*[：:]\s*([^=＝\r\n]+?)\s*[=＝]\s*([^\r\n]+)$/u.exec(prompt.trim());
  if (!match) return undefined;
  const topic = match[1].trim();
  const note = match[2].trim();
  if (!safeProfileText(topic + ' ' + note)) return undefined;
  const parsed = record.safeParse({ kind: 'preference', scope: 'profile', topic, note,
    task_id: taskId, created_at: createdAt });
  return parsed.success ? parsed.data : undefined;
}

const schema = `
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY,
    namespace TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('preference', 'lesson')),
    topic_key TEXT NOT NULL,
    topic TEXT NOT NULL,
    note TEXT NOT NULL,
    task_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    evidence_artifact TEXT,
    search_topic TEXT NOT NULL,
    search_note TEXT NOT NULL,
    UNIQUE(namespace, kind, topic_key)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS memories_by_scope ON memories(namespace, kind, created_at DESC, id DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(
    search_topic, search_note, content='memories', content_rowid='id', tokenize='unicode61 tokenchars _'
  );
  CREATE TRIGGER IF NOT EXISTS memories_insert AFTER INSERT ON memories BEGIN
    INSERT INTO memory_search(rowid, search_topic, search_note) VALUES (new.id, new.search_topic, new.search_note);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_update AFTER UPDATE ON memories BEGIN
    INSERT INTO memory_search(memory_search, rowid, search_topic, search_note)
      VALUES ('delete', old.id, old.search_topic, old.search_note);
    INSERT INTO memory_search(rowid, search_topic, search_note) VALUES (new.id, new.search_topic, new.search_note);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_delete AFTER DELETE ON memories BEGIN
    INSERT INTO memory_search(memory_search, rowid, search_topic, search_note)
      VALUES ('delete', old.id, old.search_topic, old.search_note);
  END;
`;

const visibleMemory = `
  (m.task_id <> ? OR m.namespace = 'profile') AND (
    m.namespace = ? OR (m.namespace = 'profile' AND NOT EXISTS (
      SELECT 1 FROM memories AS local
      WHERE local.namespace = ? AND local.kind = 'preference' AND local.topic_key = m.topic_key
    ))
  )
`;
const recallColumns = `
  m.id, m.kind, m.topic, m.note, m.task_id, m.created_at, m.evidence_artifact,
  CASE WHEN m.namespace = 'profile' THEN 'profile' ELSE 'connection' END AS scope
`;

function fitMemories(rows: Record<string, SQLOutputValue>[], budget: number) {
  const selected: MemoryRecord[] = [];
  let remaining = budget;
  for (const { id: _id, evidence_artifact, ...row } of rows) {
    const entry = record.parse({ ...row, evidence_artifact: evidence_artifact ?? undefined });
    const cost = estimateTokens([{ role: 'user', content: JSON.stringify(entry) }]);
    if (cost > remaining) continue;
    selected.push(entry);
    remaining -= cost;
  }
  return { selected, remaining };
}

export class LongTermMemory {
  private readonly path: string;
  private readonly directory: string;

  constructor(configDirectory: string) {
    this.directory = join(configDirectory, 'agent', 'memory');
    this.path = join(this.directory, 'library.sqlite');
  }

  async recall(fingerprint: string, taskId: string, query: string) {
    this.assertScope(fingerprint);
    try { await access(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const words = new Set([...new Set(searchTerms(query))].slice(0, 256));
    const match = [...words].map(word => '"' + word + '"').join(' OR ');
    return this.withDatabase(database => {
      const preferences = database.prepare(`
        SELECT ${recallColumns} FROM memories AS m
        WHERE ${visibleMemory} AND m.kind = 'preference'
        ORDER BY m.created_at DESC, m.id DESC LIMIT ?
      `).all(taskId, fingerprint, fingerprint, searchLimit);
      const matches = match ? database.prepare(`
        SELECT ${recallColumns}
        FROM memory_search JOIN memories AS m ON m.id = memory_search.rowid
        WHERE memory_search MATCH ? AND ${visibleMemory}
        ORDER BY bm25(memory_search, 4.0, 1.0), m.created_at DESC, m.id DESC LIMIT ?
      `).all(match, taskId, fingerprint, fingerprint, searchLimit) : [];

      const relevantPreferences = matches.filter(row => row.kind === 'preference');
      const matchedIds = new Set(relevantPreferences.map(row => row.id));
      const rankedPreferences = [...relevantPreferences, ...preferences.filter(row => !matchedIds.has(row.id))];
      const preferred = fitMemories(rankedPreferences, preferenceTokenBudget);
      const lessons = matches.filter(row => row.kind === 'lesson' &&
        (words.has(normalize(String(row.topic))) ||
          [...new Set(searchTerms(String(row.topic) + ' ' + String(row.note)))].filter(word => words.has(word)).length >= 2));
      const related = fitMemories(lessons, memoryTokenBudget - preferenceTokenBudget + preferred.remaining);
      return [...preferred.selected, ...related.selected];
    });
  }

  async save(fingerprint: string, entries: MemoryRecord[]) {
    this.assertScope(fingerprint);
    const records = recalledMemoriesSchema.parse(entries);
    if (records.some(entry => entry.scope === 'profile' && entry.kind !== 'preference'))
      throw new Error('Only preferences can be stored in the profile');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.withDatabase(database => {
      const upsert = database.prepare(`
        INSERT INTO memories (namespace, kind, topic_key, topic, note, task_id, created_at,
          evidence_artifact, search_topic, search_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(namespace, kind, topic_key) DO UPDATE SET
          topic = excluded.topic, note = excluded.note, task_id = excluded.task_id,
          created_at = excluded.created_at, evidence_artifact = excluded.evidence_artifact,
          search_topic = excluded.search_topic, search_note = excluded.search_note
        WHERE excluded.created_at >= memories.created_at
      `);
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const entry of records) {
          upsert.run(entry.scope === 'profile' ? profileNamespace : fingerprint, entry.kind,
            normalize(entry.topic).replace(/\s+/g, ' '), entry.topic, entry.note,
            entry.task_id, entry.created_at, entry.evidence_artifact ?? null,
            searchTerms(entry.topic).join(' '), searchTerms(entry.note).join(' '));
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    });
  }

  private assertScope(fingerprint: string) {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid memory scope');
  }

  private async withDatabase<T>(action: (database: DatabaseSync) => T) {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(this.path);
    try {
      database.exec('PRAGMA busy_timeout = 1500');
      // Initialize all tables and triggers together so concurrent readers see a complete schema.
      if (!database.prepare('PRAGMA user_version').get()?.user_version) {
        database.exec('BEGIN IMMEDIATE; ' + schema + ' PRAGMA user_version = 1; COMMIT;');
      }
      return action(database);
    } finally {
      database.close();
    }
  }
}
