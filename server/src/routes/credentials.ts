/** /api/credentials/* — card issuance, NFC binding, revocation. */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { type OwnerType, OWNER_TYPES, BindNfcBody, BulkCredentialsBody, CODE_ALPHABET, CODE_LENGTH, CreateCredentialBody, normalizeUid } from '@creche/shared';
import { actorOf, authOf, requireRole } from '../auth/plugin.js';
import type { Ctx } from '../context.js';
import { type Db, all, one, run, tx } from '../db/index.js';
import { bumpDirectoryVersion } from '../db/settings.js';
import type { CredentialRow } from '../db/rows.js';
import { credentialToDto, loadCredentialRow, loadCredentials } from '../dto/credentials.js';
import { audit } from '../lib/audit.js';
import { randomCode } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { parse, queryBool, queryStr } from '../lib/validate.js';

/** Generate a code that no ACTIVE credential holds. */
export function generateUniqueCode(db: Db): string {
  for (let i = 0; i < 50; i++) {
    const code = randomCode(CODE_ALPHABET, CODE_LENGTH);
    const taken = one<{ id: string }>(db, 'SELECT id FROM credentials WHERE code = ? AND active = 1', code);
    if (!taken) return code;
  }
  throw new ApiError('INTERNAL', 'Não foi possível gerar um código único');
}

export function normalizeNfcUid(raw: string): string {
  const uid = normalizeUid(raw);
  if (uid.length < 4) throw new ApiError('VALIDATION', 'UID NFC inválido', { issues: [{ path: 'uid', message: 'UID NFC inválido' }] });
  return uid;
}

export function assertUidFree(db: Db, uid: string, exceptId?: string): void {
  const row = one<{ id: string }>(db, 'SELECT id FROM credentials WHERE nfc_uid = ? AND active = 1', uid);
  if (row && row.id !== exceptId) throw new ApiError('UID_IN_USE');
}

/** Owner must exist and be active (NOT_FOUND / OWNER_INACTIVE). */
export function assertOwnerActive(db: Db, ownerType: OwnerType, ownerId: string): { name: string } {
  const row =
    ownerType === 'guardian'
      ? one<{ name: string; active: number; anonymized_at: string | null }>(db, `SELECT name, active, anonymized_at FROM users WHERE id = ? AND role = 'guardian'`, ownerId)
      : one<{ name: string; active: number; anonymized_at: string | null }>(db, 'SELECT name, active, anonymized_at FROM children WHERE id = ?', ownerId);
  if (!row) throw new ApiError('NOT_FOUND', ownerType === 'guardian' ? 'Responsável não encontrado' : 'Criança não encontrada');
  if (!row.active || row.anonymized_at) throw new ApiError('OWNER_INACTIVE');
  return row;
}

export interface CreateCredentialInput {
  ownerType: OwnerType;
  ownerId: string;
  label?: string | null;
  nfcUid?: string | null;
  actorId: string | null;
  now: Date;
}

/** Insert one credential (caller handles the transaction, audit and directory bump). */
export function insertCredential(db: Db, input: CreateCredentialInput): CredentialRow {
  const uid = input.nfcUid ? normalizeNfcUid(input.nfcUid) : null;
  if (uid) assertUidFree(db, uid);
  const id = randomUUID();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateUniqueCode(db);
    try {
      run(
        db,
        `INSERT INTO credentials (id, owner_type, owner_id, code, nfc_uid, label, active, created_by, created_at, revoked_at, revoked_by)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)`,
        id,
        input.ownerType,
        input.ownerId,
        code,
        uid,
        input.label || null,
        input.actorId,
        input.now.toISOString()
      );
      return one<CredentialRow>(db, 'SELECT * FROM credentials WHERE id = ?', id)!;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' && /credentials_active_code/.test(e.message ?? '')) continue;
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' && /credentials_active_uid/.test(e.message ?? '')) throw new ApiError('UID_IN_USE');
      throw err;
    }
  }
  throw new ApiError('CODE_IN_USE', 'Não foi possível gerar um código único');
}

export function registerCredentialRoutes(api: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const admin = requireRole('admin');

  api.get<{ Querystring: { ownerType?: string; ownerId?: string; className?: string; includeRevoked?: string } }>('/credentials', { preHandler: admin }, async (req) => {
    const ownerType = queryStr(req.query.ownerType);
    if (ownerType && !(OWNER_TYPES as readonly string[]).includes(ownerType)) throw new ApiError('VALIDATION', 'ownerType inválido');
    return loadCredentials(db, {
      ownerType: ownerType as OwnerType | undefined,
      ownerId: queryStr(req.query.ownerId),
      className: queryStr(req.query.className),
      includeRevoked: queryBool(req.query.includeRevoked),
    });
  });

  api.post('/credentials', { preHandler: admin }, async (req, reply) => {
    const body = parse(CreateCredentialBody, req.body);
    assertOwnerActive(db, body.ownerType, body.ownerId);
    const now = req.now;
    const row = tx(db, () => {
      const r = insertCredential(db, { ownerType: body.ownerType, ownerId: body.ownerId, label: body.label, nfcUid: body.nfcUid, actorId: authOf(req).user.id, now });
      audit(db, actorOf(req), 'credential.create', 'credential', r.id, { ownerType: r.owner_type, ownerId: r.owner_id, code: r.code, nfcUid: r.nfc_uid }, req.ip, now);
      bumpDirectoryVersion(db);
      return r;
    });
    return reply.code(201).send(credentialToDto(loadCredentialRow(db, row.id)!));
  });

  api.post('/credentials/bulk', { preHandler: admin }, async (req, reply) => {
    const body = parse(BulkCredentialsBody, req.body);
    const now = req.now;
    const className = body.className?.trim() || null;
    const owners =
      body.ownerType === 'child'
        ? all<{ id: string }>(db, 'SELECT id FROM children WHERE active = 1 AND anonymized_at IS NULL AND (? IS NULL OR class_name = ?) ORDER BY name', className, className)
        : all<{ id: string }>(
            db,
            `SELECT DISTINCT u.id FROM users u
             WHERE u.role = 'guardian' AND u.active = 1 AND u.anonymized_at IS NULL
               AND (? IS NULL OR u.id IN (
                 SELECT l.user_id FROM child_guardians l JOIN children c ON c.id = l.child_id
                 WHERE l.removed_at IS NULL AND c.active = 1 AND c.class_name = ?))
             ORDER BY u.name`,
            className,
            className
          );
    const created = tx(db, () => {
      const out: string[] = [];
      for (const owner of owners) {
        if (body.onlyWithout) {
          const has = one<{ id: string }>(db, 'SELECT id FROM credentials WHERE owner_type = ? AND owner_id = ? AND active = 1', body.ownerType, owner.id);
          if (has) continue;
        }
        const r = insertCredential(db, { ownerType: body.ownerType, ownerId: owner.id, actorId: authOf(req).user.id, now });
        out.push(r.id);
      }
      audit(db, actorOf(req), 'credential.bulk', 'credential', null, { ownerType: body.ownerType, className, onlyWithout: body.onlyWithout, created: out.length }, req.ip, now);
      if (out.length) bumpDirectoryVersion(db);
      return out;
    });
    return reply.code(201).send({ created: created.map((id) => credentialToDto(loadCredentialRow(db, id)!)) });
  });

  api.post<{ Params: { id: string } }>('/credentials/:id/nfc', { preHandler: requireRole('admin', 'guard') }, async (req) => {
    const body = parse(BindNfcBody, req.body);
    const row = loadCredentialRow(db, req.params.id);
    if (!row) throw new ApiError('NOT_FOUND', 'Carteirinha não encontrada');
    if (!row.active) throw new ApiError('CARD_REVOKED');
    const uid = normalizeNfcUid(body.uid);
    assertUidFree(db, uid, row.id);
    const now = req.now;
    tx(db, () => {
      run(db, 'UPDATE credentials SET nfc_uid = ? WHERE id = ?', uid, row.id);
      audit(db, actorOf(req), 'credential.nfc', 'credential', row.id, { nfcUid: uid, previous: row.nfc_uid }, req.ip, now);
      bumpDirectoryVersion(db);
    });
    return credentialToDto(loadCredentialRow(db, row.id)!);
  });

  api.delete<{ Params: { id: string } }>('/credentials/:id', { preHandler: admin }, async (req) => {
    const row = loadCredentialRow(db, req.params.id);
    if (!row) throw new ApiError('NOT_FOUND', 'Carteirinha não encontrada');
    if (row.active) {
      const now = req.now;
      tx(db, () => {
        run(db, 'UPDATE credentials SET active = 0, revoked_at = ?, revoked_by = ? WHERE id = ?', now.toISOString(), authOf(req).user.id, row.id);
        audit(db, actorOf(req), 'credential.revoke', 'credential', row.id, { ownerType: row.owner_type, ownerId: row.owner_id, code: row.code }, req.ip, now);
        bumpDirectoryVersion(db);
      });
      ctx.notifier.credentialRevoked(row.id, authOf(req).user.id);
    }
    return credentialToDto(loadCredentialRow(db, row.id)!);
  });
}
