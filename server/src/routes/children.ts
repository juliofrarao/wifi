/** /api/children/* — children, guardian links, one-off pickup authorizations. */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AnonymizeBody,
  ChildGuardianBody,
  CreateChildBody,
  CreateGuardianForChildBody,
  PickupAuthorizationBody,
  UpdateChildBody,
  addDays,
  searchKey,
  todayCivil,
} from '@creche/shared';
import { actorOf, authOf, requireRole } from '../auth/plugin.js';
import type { Ctx } from '../context.js';
import { all, one, run, tx } from '../db/index.js';
import { bumpDirectoryVersion } from '../db/settings.js';
import type { AuthorizationWithCreatorRow, ChildRow, LinkRow, LinkWithUserRow, UserRow } from '../db/rows.js';
import { authorizationToDto, loadAuthorization, AUTHORIZATION_ORDER, AUTHORIZATION_SELECT } from '../dto/authorizations.js';
import { childAdmin, childGate, childrenAdmin, childrenGate, getChild, linkAllowsPickupNow, liveLink, myChild } from '../dto/children.js';
import { userToDto } from '../dto/users.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import { photoUrl, storePhoto } from '../lib/photos.js';
import { isValidCivilDate } from '../lib/time.js';
import { parse, queryBool, queryStr } from '../lib/validate.js';
import { anonymizeChild } from '../services/anonymize.js';
import { issueInvite } from '../services/invites.js';
import { childStatus } from '../services/status.js';
import { assertEmailFree, insertUser } from '../services/users.js';
import { readUploadedFile } from './upload.js';

const MAX_AUTHORIZATION_DAYS = 30;

export function registerChildRoutes(api: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  const admin = requireRole('admin');
  const dtoCtx = (now: Date) => ({ filesSecret: ctx.filesSecret, tz: config.tz, now });

  const mustGet = (id: string): ChildRow => {
    const c = getChild(db, id);
    if (!c) throw new ApiError('NOT_FOUND', 'Criança não encontrada');
    return c;
  };

  const assertCivil = (value: string | null | undefined, field: string) => {
    if (value && !isValidCivilDate(value)) throw new ApiError('VALIDATION', 'Data inválida', { issues: [{ path: field, message: 'Data inválida' }] });
  };

  /** Guardian's own live, non-blocked link to the child (or FORBIDDEN). */
  const myLinkOrForbidden = (req: FastifyRequest, childId: string): LinkWithUserRow => {
    const link = liveLink(db, childId, authOf(req).user.id);
    if (!link || link.blocked) throw new ApiError('FORBIDDEN');
    return link;
  };

  // -------------------------------------------------------------------------
  // Children
  // -------------------------------------------------------------------------

  api.get<{ Querystring: { q?: string; className?: string; includeInactive?: string } }>('/children', { preHandler: requireRole('guard', 'admin') }, async (req) => {
    const { user } = authOf(req);
    const q = queryStr(req.query.q);
    const className = queryStr(req.query.className);
    const includeInactive = user.role === 'admin' && queryBool(req.query.includeInactive);
    let rows = all<ChildRow>(
      db,
      `SELECT * FROM children WHERE (? = 1 OR active = 1) AND (? IS NULL OR class_name = ?) ORDER BY name`,
      includeInactive ? 1 : 0,
      className ?? null,
      className ?? null
    );
    if (q) {
      const key = searchKey(q);
      rows = rows.filter((c) => searchKey(c.name).includes(key));
    }
    return user.role === 'admin' ? childrenAdmin(db, rows, dtoCtx(req.now), { recentEvents: 5 }) : childrenGate(db, rows, dtoCtx(req.now));
  });

  api.post('/children', { preHandler: admin }, async (req, reply) => {
    const body = parse(CreateChildBody, req.body);
    assertCivil(body.birthDate, 'birthDate');
    assertCivil(body.consentAt, 'consentAt');
    const now = req.now;
    const id = randomUUID();
    tx(db, () => {
      run(
        db,
        `INSERT INTO children (id, name, birth_date, class_name, shift, gate_alert, notes, photo_file_id, active, deactivated_at,
           consent_at, consent_by_name, consent_relationship, anonymized_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, NULL, ?, ?, ?, NULL, ?, ?)`,
        id,
        body.name,
        body.birthDate ?? null,
        body.className || null,
        body.shift ?? null,
        body.gateAlert || null,
        body.notes || null,
        body.consentAt ?? null,
        body.consentByName || null,
        body.consentRelationship ?? null,
        now.toISOString(),
        now.toISOString()
      );
      audit(db, actorOf(req), 'child.create', 'child', id, { name: body.name, className: body.className ?? null }, req.ip, now);
      bumpDirectoryVersion(db);
    });
    return reply.code(201).send(childAdmin(db, mustGet(id), dtoCtx(now)));
  });

  api.get<{ Params: { id: string } }>('/children/:id', { preHandler: requireRole('admin', 'guard', 'guardian') }, async (req) => {
    const child = mustGet(req.params.id);
    const { user } = authOf(req);
    const c = dtoCtx(req.now);
    if (user.role === 'admin') return childAdmin(db, child, c);
    if (user.role === 'guard') {
      if (!child.active) throw new ApiError('NOT_FOUND', 'Criança não encontrada');
      return childGate(db, child, c);
    }
    const link = myLinkOrForbidden(req, child.id);
    if (child.anonymized_at) throw new ApiError('NOT_FOUND', 'Criança não encontrada');
    return myChild(db, child, link, c);
  });

  api.patch<{ Params: { id: string } }>('/children/:id', { preHandler: admin }, async (req) => {
    const body = parse(UpdateChildBody, req.body);
    const child = mustGet(req.params.id);
    if (child.anonymized_at) throw new ApiError('INVALID_STATE', 'Criança anonimizada');
    assertCivil(body.birthDate, 'birthDate');
    assertCivil(body.consentAt, 'consentAt');
    const now = req.now;
    const actor = actorOf(req);
    const pick = <K extends keyof typeof body>(k: K, current: unknown) => (body[k] === undefined ? current : body[k]);
    tx(db, () => {
      const deactivating = body.active === false && child.active === 1;
      const reactivating = body.active === true && child.active === 0;
      run(
        db,
        `UPDATE children SET name = ?, birth_date = ?, class_name = ?, shift = ?, gate_alert = ?, notes = ?,
           consent_at = ?, consent_by_name = ?, consent_relationship = ?, active = ?, deactivated_at = ?, updated_at = ? WHERE id = ?`,
        pick('name', child.name),
        pick('birthDate', child.birth_date),
        pick('className', child.class_name) || null,
        pick('shift', child.shift),
        pick('gateAlert', child.gate_alert) || null,
        pick('notes', child.notes) || null,
        pick('consentAt', child.consent_at),
        pick('consentByName', child.consent_by_name) || null,
        pick('consentRelationship', child.consent_relationship),
        body.active === undefined ? child.active : body.active ? 1 : 0,
        deactivating ? now.toISOString() : reactivating ? null : child.deactivated_at,
        now.toISOString(),
        child.id
      );
      if (deactivating) {
        // R17: a present child gets an automatic checkout (no notifications).
        const status = childStatus(db, child.id, { now, tz: config.tz, admin: true });
        if (status.present) {
          const guard = authOf(req).user;
          run(
            db,
            `INSERT INTO attendance_events (id, client_id, batch_id, child_id, child_name, type, guardian_id, guardian_name, guardian_relationship,
               person_name, person_document, document_checked, authorization_id, authorized_by_name, guard_id, guard_name, method, credential_id,
               override, conflict, queued, directory_at, note, occurred_at, created_at, voided_at, voided_by, void_reason)
             VALUES (?, NULL, ?, ?, ?, 'checkout', NULL, NULL, NULL, ?, NULL, 0, NULL, NULL, ?, ?, 'auto', NULL, 0, NULL, 0, NULL, ?, ?, ?, NULL, NULL, NULL)`,
            randomUUID(),
            randomUUID(),
            child.id,
            child.name,
            'Sistema',
            guard.id,
            guard.name,
            'Desligamento',
            now.toISOString(),
            now.toISOString()
          );
        }
      }
      const changed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) if (v !== undefined) changed[k] = v;
      audit(db, actor, deactivating ? 'child.deactivate' : reactivating ? 'child.reactivate' : 'child.update', 'child', child.id, changed, req.ip, now);
      bumpDirectoryVersion(db);
    });
    return childAdmin(db, mustGet(child.id), dtoCtx(now));
  });

  api.post<{ Params: { id: string } }>('/children/:id/photo', { preHandler: admin }, async (req) => {
    const child = mustGet(req.params.id);
    if (child.anonymized_at) throw new ApiError('INVALID_STATE', 'Criança anonimizada');
    const buffer = await readUploadedFile(req, 'photo');
    const fileId = tx(db, () => {
      const id = storePhoto(db, config, { ownerTable: 'children', ownerId: child.id, buffer, actorId: authOf(req).user.id, now: req.now });
      audit(db, actorOf(req), 'child.photo', 'child', child.id, { fileId: id, size: buffer.length }, req.ip, req.now);
      bumpDirectoryVersion(db);
      return id;
    });
    return { photoUrl: photoUrl(fileId, ctx.filesSecret) };
  });

  api.post<{ Params: { id: string } }>('/children/:id/anonymize', { preHandler: admin }, async (req, reply) => {
    const body = parse(AnonymizeBody, req.body);
    const child = mustGet(req.params.id);
    anonymizeChild(db, config, child, { actor: actorOf(req), reason: body.reason, ip: req.ip, now: req.now });
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // Guardian links
  // -------------------------------------------------------------------------

  interface LinkInput {
    relationship: LinkRow['relationship'];
    canPickup: boolean;
    isPrimary: boolean;
    validFrom?: string | null;
    validUntil?: string | null;
    blocked: boolean;
    blockedReason?: string | null;
  }

  const validateLinkDates = (input: LinkInput) => {
    assertCivil(input.validFrom, 'validFrom');
    assertCivil(input.validUntil, 'validUntil');
    if (input.validFrom && input.validUntil && input.validUntil < input.validFrom) {
      throw new ApiError('VALIDATION', 'Validade final antes da inicial', { issues: [{ path: 'validUntil', message: 'Validade final antes da inicial' }] });
    }
  };

  /**
   * Create or update the live link. Returns whether R16 applies (the person
   * became able to pick up, or their validity was extended).
   */
  const upsertLink = (child: ChildRow, user: UserRow, input: LinkInput, req: FastifyRequest): { created: boolean; notify: boolean } => {
    const now = req.now;
    const today = todayCivil(config.tz, now);
    const actor = actorOf(req);
    const existing = one<LinkRow>(db, 'SELECT * FROM child_guardians WHERE child_id = ? AND user_id = ? AND removed_at IS NULL', child.id, user.id);
    const allowedNow = (l: Pick<LinkRow, 'can_pickup' | 'valid_from' | 'valid_until' | 'blocked'>) => linkAllowsPickupNow(l, today);
    const next = {
      can_pickup: input.canPickup ? 1 : 0,
      valid_from: input.validFrom ?? null,
      valid_until: input.validUntil ?? null,
      blocked: input.blocked ? 1 : 0,
    };
    if (input.isPrimary) run(db, 'UPDATE child_guardians SET is_primary = 0 WHERE child_id = ? AND removed_at IS NULL AND user_id <> ?', child.id, user.id);
    if (!existing) {
      run(
        db,
        `INSERT INTO child_guardians (id, child_id, user_id, relationship, can_pickup, is_primary, valid_from, valid_until, blocked, blocked_reason,
           created_by, created_at, updated_by, updated_at, removed_at, removed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        randomUUID(),
        child.id,
        user.id,
        input.relationship,
        next.can_pickup,
        input.isPrimary ? 1 : 0,
        next.valid_from,
        next.valid_until,
        next.blocked,
        input.blocked ? input.blockedReason || null : null,
        actor.id,
        now.toISOString(),
        actor.id,
        now.toISOString()
      );
      audit(db, actor, 'link.create', 'child_guardian', child.id, { userId: user.id, ...input }, req.ip, now);
      return { created: true, notify: next.can_pickup === 1 && next.blocked === 0 };
    }
    run(
      db,
      `UPDATE child_guardians SET relationship = ?, can_pickup = ?, is_primary = ?, valid_from = ?, valid_until = ?, blocked = ?, blocked_reason = ?,
         updated_by = ?, updated_at = ? WHERE id = ?`,
      input.relationship,
      next.can_pickup,
      input.isPrimary ? 1 : 0,
      next.valid_from,
      next.valid_until,
      next.blocked,
      input.blocked ? input.blockedReason || null : null,
      actor.id,
      now.toISOString(),
      existing.id
    );
    audit(db, actor, 'link.update', 'child_guardian', child.id, { userId: user.id, ...input }, req.ip, now);
    const wasAllowed = allowedNow(existing);
    const isAllowed = allowedNow(next);
    const extended =
      isAllowed && wasAllowed && ((existing.valid_until !== null && (next.valid_until === null || next.valid_until > existing.valid_until)) || (existing.valid_from !== null && (next.valid_from === null || next.valid_from < existing.valid_from)));
    return { created: false, notify: (!wasAllowed && isAllowed) || extended };
  };

  api.post<{ Params: { id: string } }>('/children/:id/guardians', { preHandler: admin }, async (req, reply) => {
    const body = parse(CreateGuardianForChildBody, req.body);
    const child = mustGet(req.params.id);
    if (child.anonymized_at) throw new ApiError('INVALID_STATE', 'Criança anonimizada');
    validateLinkDates(body);
    assertEmailFree(db, body.email);
    const now = req.now;
    const { user, notify } = tx(db, () => {
      const u = insertUser(db, { name: body.name, email: body.email, phone: body.phone, role: 'guardian', now });
      audit(db, actorOf(req), 'user.create', 'user', u.id, { role: 'guardian', email: u.email, childId: child.id }, req.ip, now);
      const res = upsertLink(child, u, body, req);
      bumpDirectoryVersion(db);
      return { user: u, notify: res.notify };
    });
    if (notify) ctx.notifier.guardianAdded(child.id, user.id, authOf(req).user.id);
    const invite = await issueInvite(ctx, user, { kind: 'invite', send: body.sendInvite ?? !!user.email });
    return reply.code(201).send({ child: childAdmin(db, mustGet(child.id), dtoCtx(now)), guardian: userToDto(user, ctx), invite });
  });

  api.put<{ Params: { id: string; userId: string } }>('/children/:id/guardians/:userId', { preHandler: admin }, async (req) => {
    const body = parse(ChildGuardianBody, req.body);
    const child = mustGet(req.params.id);
    if (child.anonymized_at) throw new ApiError('INVALID_STATE', 'Criança anonimizada');
    const user = one<UserRow>(db, `SELECT * FROM users WHERE id = ? AND role = 'guardian' AND anonymized_at IS NULL`, req.params.userId);
    if (!user) throw new ApiError('NOT_FOUND', 'Responsável não encontrado');
    validateLinkDates(body);
    const { notify } = tx(db, () => {
      const res = upsertLink(child, user, body, req);
      bumpDirectoryVersion(db);
      return res;
    });
    if (notify) ctx.notifier.guardianAdded(child.id, user.id, authOf(req).user.id);
    return childAdmin(db, mustGet(child.id), dtoCtx(req.now));
  });

  api.delete<{ Params: { id: string; userId: string } }>('/children/:id/guardians/:userId', { preHandler: admin }, async (req) => {
    const child = mustGet(req.params.id);
    const existing = one<LinkRow>(db, 'SELECT * FROM child_guardians WHERE child_id = ? AND user_id = ? AND removed_at IS NULL', child.id, req.params.userId);
    if (!existing) throw new ApiError('NOT_FOUND', 'Vínculo não encontrado');
    const now = req.now;
    tx(db, () => {
      run(db, 'UPDATE child_guardians SET removed_at = ?, removed_by = ? WHERE id = ?', now.toISOString(), authOf(req).user.id, existing.id);
      audit(db, actorOf(req), 'link.remove', 'child_guardian', child.id, { userId: req.params.userId }, req.ip, now);
      bumpDirectoryVersion(db);
    });
    return childAdmin(db, mustGet(child.id), dtoCtx(now));
  });

  // -------------------------------------------------------------------------
  // One-off pickup authorizations
  // -------------------------------------------------------------------------

  api.get<{ Params: { id: string }; Querystring: { includeExpired?: string } }>(
    '/children/:id/pickup-authorizations',
    { preHandler: requireRole('admin', 'guardian') },
    async (req) => {
      const child = mustGet(req.params.id);
      const { user } = authOf(req);
      const isAdmin = user.role === 'admin';
      if (!isAdmin) myLinkOrForbidden(req, child.id);
      const today = todayCivil(config.tz, req.now);
      const includeExpired = queryBool(req.query.includeExpired);
      const rows = includeExpired
        ? all<AuthorizationWithCreatorRow>(db, `${AUTHORIZATION_SELECT} WHERE a.child_id = ? ORDER BY ${AUTHORIZATION_ORDER}`, child.id)
        : all<AuthorizationWithCreatorRow>(
            db,
            `${AUTHORIZATION_SELECT} WHERE a.child_id = ? AND a.revoked_at IS NULL AND a.valid_until >= ? ORDER BY ${AUTHORIZATION_ORDER}`,
            child.id,
            today
          );
      return rows.map((r) => authorizationToDto(r, { today, admin: isAdmin }));
    }
  );

  api.post<{ Params: { id: string } }>('/children/:id/pickup-authorizations', { preHandler: requireRole('admin', 'guardian') }, async (req, reply) => {
    const body = parse(PickupAuthorizationBody, req.body);
    const child = mustGet(req.params.id);
    if (!child.active) throw new ApiError('INVALID_STATE', 'Criança desligada');
    const { user } = authOf(req);
    const isAdmin = user.role === 'admin';
    const today = todayCivil(config.tz, req.now);
    if (!isAdmin) {
      const link = myLinkOrForbidden(req, child.id);
      if (!linkAllowsPickupNow(link, today)) throw new ApiError('FORBIDDEN', 'Só quem pode retirar a criança pode autorizar outra pessoa');
    }
    assertCivil(body.validFrom, 'validFrom');
    assertCivil(body.validUntil, 'validUntil');
    const validFrom = body.validFrom ?? today;
    const validUntil = body.validUntil ?? validFrom;
    if (validUntil < validFrom) throw new ApiError('VALIDATION', 'Validade final antes da inicial', { issues: [{ path: 'validUntil', message: 'Validade final antes da inicial' }] });
    if (validUntil > addDays(validFrom, MAX_AUTHORIZATION_DAYS)) {
      throw new ApiError('VALIDATION', `A autorização pode valer por no máximo ${MAX_AUTHORIZATION_DAYS} dias`, { issues: [{ path: 'validUntil', message: 'Máximo de 30 dias' }] });
    }
    if (validUntil < today) throw new ApiError('VALIDATION', 'A validade já terminou', { issues: [{ path: 'validUntil', message: 'A validade já terminou' }] });
    const now = req.now;
    const id = randomUUID();
    tx(db, () => {
      run(
        db,
        `INSERT INTO pickup_authorizations (id, child_id, person_name, person_document, relationship_label, phone, valid_from, valid_until, note, created_by, created_at, revoked_at, revoked_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        id,
        child.id,
        body.personName,
        body.personDocument || null,
        body.relationshipLabel,
        body.phone || null,
        validFrom,
        validUntil,
        body.note || null,
        user.id,
        now.toISOString()
      );
      audit(db, actorOf(req), 'authorization.create', 'pickup_authorization', id, { childId: child.id, personName: body.personName, validFrom, validUntil }, req.ip, now);
      bumpDirectoryVersion(db);
    });
    ctx.notifier.authorizationAdded(id, user.id);
    return reply.code(201).send(authorizationToDto(loadAuthorization(db, id)!, { today, admin: isAdmin }));
  });

  api.delete<{ Params: { id: string; authId: string } }>(
    '/children/:id/pickup-authorizations/:authId',
    { preHandler: requireRole('admin', 'guardian') },
    async (req, reply) => {
      const child = mustGet(req.params.id);
      const auth = loadAuthorization(db, req.params.authId);
      if (!auth || auth.child_id !== child.id) throw new ApiError('NOT_FOUND', 'Autorização não encontrada');
      const { user } = authOf(req);
      if (user.role !== 'admin' && auth.created_by !== user.id) throw new ApiError('FORBIDDEN');
      if (!auth.revoked_at) {
        const now = req.now;
        tx(db, () => {
          run(db, 'UPDATE pickup_authorizations SET revoked_at = ?, revoked_by = ? WHERE id = ?', now.toISOString(), user.id, auth.id);
          audit(db, actorOf(req), 'authorization.revoke', 'pickup_authorization', auth.id, { childId: child.id }, req.ip, now);
          bumpDirectoryVersion(db);
        });
      }
      return reply.code(204).send();
    }
  );
}
