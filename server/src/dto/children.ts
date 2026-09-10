/**
 * children rows → ChildDTO / ChildGateDTO / ChildAdminDTO / MyChildDTO and the
 * guardian-link projections (R10). Every projection is explicit: the gate never
 * receives contacts or notes; a guardian never receives co-guardian photos,
 * contacts, gateAlert or notes.
 */
import {
  type ChildAdminDTO,
  type ChildDTO,
  type ChildGateDTO,
  type ChildStatus,
  type GuardianLink,
  type GuardianLinkAdmin,
  type GuardianLinkGate,
  type MyChildDTO,
  type PickupAuthorizationDTO,
  pickupAllowed,
  relationshipLabel,
  todayCivil,
} from '@creche/shared';
import { type Db, all, one, placeholders } from '../db/index.js';
import { type ChildRow, type LinkRow, type LinkWithUserRow, bool } from '../db/rows.js';
import { photoUrl } from '../lib/photos.js';
import { childStatuses } from '../services/status.js';
import { authorizationToDto, authorizationsByChild } from './authorizations.js';
import { credentialsByOwner } from './credentials.js';
import { eventToDto, recentEventsByChild } from './events.js';

export interface ChildDtoCtx {
  filesSecret: string;
  tz: string;
  now: Date;
}

function todayOf(ctx: ChildDtoCtx): string {
  return todayCivil(ctx.tz, ctx.now);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export const LINK_SELECT = `
  SELECT l.*, u.name AS u_name, u.email AS u_email, u.login AS u_login, u.phone AS u_phone,
         u.photo_file_id AS u_photo_file_id, u.active AS u_active, u.password_hash AS u_password_hash,
         (SELECT COUNT(*) FROM push_subscriptions p WHERE p.user_id = u.id) AS u_push_count
  FROM child_guardians l JOIN users u ON u.id = l.user_id`;

/** Live links (removed_at IS NULL) of many children, joined with the guardian user. */
export function linksByChild(db: Db, childIds: string[]): Map<string, LinkWithUserRow[]> {
  const out = new Map<string, LinkWithUserRow[]>();
  if (childIds.length === 0) return out;
  const rows = all<LinkWithUserRow>(
    db,
    `${LINK_SELECT} WHERE l.removed_at IS NULL AND l.child_id IN (${placeholders(childIds.length)})
     ORDER BY l.is_primary DESC, u.name, l.created_at`,
    ...childIds
  );
  for (const row of rows) {
    const list = out.get(row.child_id) ?? [];
    list.push(row);
    out.set(row.child_id, list);
  }
  return out;
}

export function liveLink(db: Db, childId: string, userId: string): LinkWithUserRow | undefined {
  return one<LinkWithUserRow>(db, `${LINK_SELECT} WHERE l.child_id = ? AND l.user_id = ? AND l.removed_at IS NULL`, childId, userId);
}

export function linkAllowsPickupNow(link: Pick<LinkRow, 'can_pickup' | 'valid_from' | 'valid_until' | 'blocked'>, today: string): boolean {
  return pickupAllowed({ canPickup: bool(link.can_pickup), validFrom: link.valid_from, validUntil: link.valid_until, blocked: bool(link.blocked) }, today);
}

export function linkToGuardianLink(row: LinkWithUserRow, today: string): GuardianLink {
  return {
    id: row.user_id,
    name: row.u_name,
    relationship: row.relationship,
    relationshipLabel: relationshipLabel(row.relationship),
    canPickup: bool(row.can_pickup),
    isPrimary: bool(row.is_primary),
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    pickupAllowedNow: linkAllowsPickupNow(row, today),
  };
}

export function linkToGate(row: LinkWithUserRow, ctx: ChildDtoCtx, today = todayOf(ctx)): GuardianLinkGate {
  return { ...linkToGuardianLink(row, today), photoUrl: photoUrl(row.u_photo_file_id, ctx.filesSecret), blocked: bool(row.blocked) };
}

export function reachableOf(row: LinkWithUserRow): GuardianLinkAdmin['reachable'] {
  if (!bool(row.u_active) || bool(row.blocked)) return 'none';
  if (row.u_push_count > 0) return 'push';
  if (row.u_email) return 'email';
  if (row.u_password_hash) return 'inapp';
  return 'none';
}

export function linkToAdmin(row: LinkWithUserRow, ctx: ChildDtoCtx, today = todayOf(ctx)): GuardianLinkAdmin {
  return {
    ...linkToGate(row, ctx, today),
    email: row.u_email,
    login: row.u_login,
    phone: row.u_phone,
    hasAccess: row.u_password_hash !== null,
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    reachable: reachableOf(row),
  };
}

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

export function childBase(row: ChildRow, status: ChildStatus, ctx: ChildDtoCtx): ChildDTO {
  return {
    id: row.id,
    name: row.name,
    birthDate: row.birth_date,
    className: row.class_name,
    shift: row.shift,
    photoUrl: photoUrl(row.photo_file_id, ctx.filesSecret),
    active: bool(row.active),
    status,
    createdAt: row.created_at,
  };
}

interface Batches {
  today: string;
  statuses: Map<string, ChildStatus>;
  links: Map<string, LinkWithUserRow[]>;
  validToday: Map<string, PickupAuthorizationDTO[]>;
}

function loadBatches(db: Db, rows: ChildRow[], ctx: ChildDtoCtx, admin: boolean): Batches {
  const ids = rows.map((r) => r.id);
  const today = todayOf(ctx);
  const statuses = childStatuses(db, ids, { now: ctx.now, tz: ctx.tz, admin });
  const links = linksByChild(db, ids);
  const validToday = new Map<string, PickupAuthorizationDTO[]>();
  for (const [childId, auths] of authorizationsByChild(db, ids, 'valid_today', today)) {
    validToday.set(
      childId,
      auths.map((a) => authorizationToDto(a, { today, admin }))
    );
  }
  return { today, statuses, links, validToday };
}

const gateLinks = (links: LinkWithUserRow[] | undefined) => (links ?? []).filter((l) => bool(l.u_active));

/** Gate projection for many children (batched queries). */
export function childrenGate(db: Db, rows: ChildRow[], ctx: ChildDtoCtx): ChildGateDTO[] {
  const b = loadBatches(db, rows, ctx, false);
  return rows.map((row) => ({
    ...childBase(row, b.statuses.get(row.id)!, ctx),
    gateAlert: row.gate_alert,
    guardians: gateLinks(b.links.get(row.id)).map((l) => linkToGate(l, ctx, b.today)),
    authorizedPersons: b.validToday.get(row.id) ?? [],
  }));
}

export function childGate(db: Db, row: ChildRow, ctx: ChildDtoCtx): ChildGateDTO {
  return childrenGate(db, [row], ctx)[0];
}

export interface AdminProjectionOptions {
  /** Number of recent events per child (20 for detail, 5 for lists). */
  recentEvents?: number;
}

/** Admin projection for many children (batched queries). */
export function childrenAdmin(db: Db, rows: ChildRow[], ctx: ChildDtoCtx, opts: AdminProjectionOptions = {}): ChildAdminDTO[] {
  const b = loadBatches(db, rows, ctx, true);
  const ids = rows.map((r) => r.id);
  const credentials = credentialsByOwner(db, 'child', ids);
  const recent = recentEventsByChild(db, ids, opts.recentEvents ?? 20);
  const current = authorizationsByChild(db, ids, 'current', b.today);
  return rows.map((row) => ({
    ...childBase(row, b.statuses.get(row.id)!, ctx),
    gateAlert: row.gate_alert,
    guardians: (b.links.get(row.id) ?? []).map((l) => linkToAdmin(l, ctx, b.today)),
    authorizedPersons: b.validToday.get(row.id) ?? [],
    notes: row.notes,
    consentAt: row.consent_at,
    consentByName: row.consent_by_name,
    consentRelationship: row.consent_relationship,
    deactivatedAt: row.deactivated_at,
    anonymizedAt: row.anonymized_at,
    credentials: credentials.get(row.id) ?? [],
    recentEvents: (recent.get(row.id) ?? []).map((e) => eventToDto(e, { admin: true })),
    authorizations: (current.get(row.id) ?? []).map((a) => authorizationToDto(a, { today: b.today, admin: true })),
  }));
}

export function childAdmin(db: Db, row: ChildRow, ctx: ChildDtoCtx): ChildAdminDTO {
  return childrenAdmin(db, [row], ctx, { recentEvents: 20 })[0];
}

/** Guardian projection: `rows` are the children and `myLinks` the caller's own live link per child. */
export function myChildren(db: Db, rows: ChildRow[], myLinks: Map<string, LinkRow>, ctx: ChildDtoCtx): MyChildDTO[] {
  const b = loadBatches(db, rows, ctx, false);
  return rows.map((row) => {
    const mine = myLinks.get(row.id)!;
    return {
      ...childBase(row, b.statuses.get(row.id)!, ctx),
      myRelationship: mine.relationship,
      myCanPickup: bool(mine.can_pickup),
      guardians: gateLinks(b.links.get(row.id))
        .filter((l) => !bool(l.blocked))
        .map((l) => linkToGuardianLink(l, b.today)),
      authorizedPersons: b.validToday.get(row.id) ?? [],
    };
  });
}

export function myChild(db: Db, row: ChildRow, myLink: LinkRow, ctx: ChildDtoCtx): MyChildDTO {
  return myChildren(db, [row], new Map([[row.id, myLink]]), ctx)[0];
}

export function getChild(db: Db, id: string): ChildRow | undefined {
  return one<ChildRow>(db, 'SELECT * FROM children WHERE id = ?', id);
}
