/**
 * 数据库：打开、建表、迁移。
 *
 * ## 为什么 bind_ids 的主键里有 client_id
 *
 * 共享库的关键约束是「多个 bot 实例各自上传自己对某个 QQ 的绑定，谁都不能覆盖谁」。
 * 如果主键只有 (qq_hash, camp_id)，那用户在本实例删掉一个营地ID 时就没法表达
 * 「这条我不要了」——覆盖式上传会连带把别的实例贡献的记录一起抹掉，
 * 而「删掉本实例的这条」和「撤销全部共享」是两件完全不同的事。
 *
 * 所以拆成 (qq_hash, client_id, camp_id)：
 *   - 上传 = 只替换 **本 client** 对该 QQ 的整组记录（本实例的删除能生效）
 *   - 查询 = 把该 QQ 下所有 client 的记录并集返回（别的实例的号也能用）
 *
 * ## 为什么 current 存的是营地ID 而不是下标
 *
 * 并集之后数组顺序变了，下标必然失效。存具体的营地ID，合并时才能在结果里找到它。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  token_hash    TEXT    NOT NULL UNIQUE,
  token_prefix  TEXT    NOT NULL,
  quota_per_day INTEGER NOT NULL DEFAULT 2000,
  write_per_hour INTEGER NOT NULL DEFAULT 60,
  enabled       INTEGER NOT NULL DEFAULT 1,
  note          TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bind_ids (
  qq_hash       TEXT    NOT NULL,
  client_id     INTEGER NOT NULL,
  camp_id       TEXT    NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (qq_hash, client_id, camp_id)
);
CREATE INDEX IF NOT EXISTS idx_bind_ids_seen ON bind_ids(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_bind_ids_client ON bind_ids(client_id);

CREATE TABLE IF NOT EXISTS bind_current (
  qq_hash         TEXT    NOT NULL,
  client_id       INTEGER NOT NULL,
  current_camp_id TEXT    NOT NULL DEFAULT '',
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (qq_hash, client_id)
);

CREATE TABLE IF NOT EXISTS quota (
  client_id INTEGER NOT NULL,
  day       TEXT    NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, day)
);

-- 撤销墓碑：让「用户已经撤销共享」压得过别的实例缓存里的旧值重放
CREATE TABLE IF NOT EXISTS revoke_log (
  qq_hash    TEXT PRIMARY KEY,
  revoked_at INTEGER NOT NULL
);

-- 审计。detail 里绝不写 QQ 或营地ID 明文
CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  client_id INTEGER,
  action    TEXT    NOT NULL,
  qq_hash   TEXT    NOT NULL DEFAULT '',
  ok        INTEGER NOT NULL DEFAULT 1,
  detail    TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
`

/**
 * @param {string} dbPath
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openDatabase (dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const db = new DatabaseSync(dbPath)

  // WAL 让读写不互相阻塞；busy_timeout 兜住清理任务和请求撞车的瞬间；
  // synchronous=NORMAL 在 WAL 下已经足够安全（丢的最多是最后一个事务，不是整库）
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')

  db.exec(SCHEMA)

  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  if (!row) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('created_at', String(Date.now()))
  } else if (Number(row.value) > SCHEMA_VERSION) {
    // 降级运行会静默写坏新版数据，宁可起不来也不降级
    throw new Error(
      `数据库 schema 版本是 ${row.value}，本程序只认到 ${SCHEMA_VERSION}。` +
      '请用更新版本的程序打开，不要用旧版覆盖。'
    )
  }

  return db
}
