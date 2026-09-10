/** Audit log (R18): every administrative mutation writes one row. */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';

export interface Actor {
  id: string | null;
  name: string | null;
}

export function audit(
  db: Db,
  actor: Actor | null,
  action: string,
  entityType: string,
  entityId: string | null,
  details?: unknown,
  ip?: string | null,
  now: Date = new Date()
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO audit_log (id, at, actor_id, actor_name, action, entity_type, entity_id, details_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, now.toISOString(), actor?.id ?? null, actor?.name ?? null, action, entityType, entityId, details === undefined ? null : JSON.stringify(details), ip ?? null);
  return id;
}
