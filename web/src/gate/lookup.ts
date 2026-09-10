/**
 * Pure directory helpers (no DOM, no stores) — unit tested.
 */
import {
  authorizationValid,
  normalizeCode,
  normalizeUid,
  pickupAllowed,
  relationshipLabel,
  searchKey,
  type ChildGateDTO,
  type ChildStatus,
  type GuardianLinkGate,
  type OwnerType,
  type PickupAuthorizationDTO,
  type ScanChildDTO,
  type ScanDirectory,
  type ScanLookupResult,
} from '@creche/shared';

export type DirectoryCredential = ScanDirectory['credentials'][number];

export interface CredentialMatch {
  credential: DirectoryCredential | null;
  /** code and uid resolve to different credentials. */
  mismatch: boolean;
  matchedBy: 'code' | 'nfc_uid' | null;
}

/** Finds a credential by normalized code and/or uid (active ones first). */
export function findCredential(dir: ScanDirectory | null, key: { code?: string | null; uid?: string | null }): CredentialMatch {
  if (!dir) return { credential: null, mismatch: false, matchedBy: null };
  const code = key.code ? normalizeCode(key.code) : null;
  const uid = key.uid ? normalizeUid(key.uid) : null;
  const pick = (list: DirectoryCredential[]) => list.find((c) => c.active) ?? list[0] ?? null;
  const byCode = code ? pick(dir.credentials.filter((c) => c.code === code)) : null;
  const byUid = uid ? pick(dir.credentials.filter((c) => c.nfcUid === uid)) : null;
  if (byCode && byUid && byCode.id !== byUid.id) return { credential: null, mismatch: true, matchedBy: null };
  if (byUid) return { credential: byUid, mismatch: false, matchedBy: 'nfc_uid' };
  if (byCode) return { credential: byCode, mismatch: false, matchedBy: 'code' };
  return { credential: null, mismatch: false, matchedBy: null };
}

export function hasAnyNfc(dir: ScanDirectory | null): boolean {
  return Boolean(dir?.credentials.some((c) => c.active && c.nfcUid));
}

export function classNamesOf(dir: ScanDirectory | null): string[] {
  const set = new Set<string>();
  for (const c of dir?.children ?? []) if (c.active && c.className) set.add(c.className);
  return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function withLinkFlags(link: GuardianLinkGate, today: string): GuardianLinkGate {
  return { ...link, pickupAllowedNow: pickupAllowed(link, today) };
}

function validAuthorizations(list: PickupAuthorizationDTO[], today: string): PickupAuthorizationDTO[] {
  return list.filter((a) => authorizationValid(a, today)).map((a) => ({ ...a, validNow: true }));
}

/** Child projection with today's link flags recomputed. */
export function refreshChild(child: ChildGateDTO, today: string, statusOf?: (childId: string) => ChildStatus): ChildGateDTO {
  return {
    ...child,
    status: statusOf ? statusOf(child.id) : child.status,
    guardians: child.guardians.map((g) => withLinkFlags(g, today)),
    authorizedPersons: validAuthorizations(child.authorizedPersons, today),
  };
}

export interface BuildLookupOptions {
  matchedBy?: 'code' | 'nfc_uid' | 'search';
  credentialId?: string | null;
  /** Restrict a guardian lookup to these children (child card → guardian). */
  childIds?: string[];
  /** Status overlay (local events); defaults to the directory status. */
  statusOf?: (childId: string) => ChildStatus;
}

export type BuildLookupOutcome =
  | { ok: true; result: ScanLookupResult }
  | { ok: false; reason: 'not_found' | 'inactive' };

/**
 * Builds a ScanLookupResult from the offline directory, recomputing
 * pickupAllowedNow / validNow for the given civil date.
 */
export function buildLookupFromDirectory(
  dir: ScanDirectory,
  ownerType: OwnerType,
  ownerId: string,
  today: string,
  opts: BuildLookupOptions = {}
): BuildLookupOutcome {
  const matchedBy = opts.matchedBy ?? 'search';
  const credentialId = opts.credentialId ?? null;
  if (ownerType === 'guardian') {
    const guardian = dir.guardians.find((g) => g.id === ownerId);
    if (!guardian) return { ok: false, reason: 'not_found' };
    if (!guardian.active) return { ok: false, reason: 'inactive' };
    const children: ScanChildDTO[] = [];
    for (const child of dir.children) {
      if (!child.active) continue;
      if (opts.childIds && !opts.childIds.includes(child.id)) continue;
      const link = child.guardians.find((g) => g.id === ownerId);
      if (!link) continue;
      const fresh = refreshChild(child, today, opts.statusOf);
      children.push({
        ...fresh,
        relationship: link.relationship,
        relationshipLabel: link.relationshipLabel || relationshipLabel(link.relationship),
        canPickup: link.canPickup,
        blocked: link.blocked,
        pickupAllowedNow: pickupAllowed(link, today),
      });
    }
    children.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return {
      ok: true,
      result: {
        kind: 'guardian',
        matchedBy,
        credentialId,
        guardian: { id: guardian.id, name: guardian.name, photoUrl: guardian.photoUrl },
        children,
      },
    };
  }
  const child = dir.children.find((c) => c.id === ownerId);
  if (!child) return { ok: false, reason: 'not_found' };
  if (!child.active) return { ok: false, reason: 'inactive' };
  const fresh = refreshChild(child, today, opts.statusOf);
  return {
    ok: true,
    result: {
      kind: 'child',
      matchedBy,
      credentialId,
      child: fresh,
      guardians: fresh.guardians,
      authorizedPersons: fresh.authorizedPersons,
    },
  };
}

/**
 * Turns a child-kind result into a guardian-kind one for a specific guardian
 * (the guard tapped a person in the child's list). Works for live results too.
 */
export function guardianResultFromChild(result: Extract<ScanLookupResult, { kind: 'child' }>, guardianId: string, today: string): ScanLookupResult | null {
  const link = result.guardians.find((g) => g.id === guardianId);
  if (!link) return null;
  const child: ScanChildDTO = {
    ...result.child,
    relationship: link.relationship,
    relationshipLabel: link.relationshipLabel || relationshipLabel(link.relationship),
    canPickup: link.canPickup,
    blocked: link.blocked,
    pickupAllowedNow: pickupAllowed(link, today),
  };
  return {
    kind: 'guardian',
    matchedBy: result.matchedBy,
    credentialId: result.credentialId,
    guardian: { id: link.id, name: link.name, photoUrl: link.photoUrl },
    children: [child],
  };
}

/** Recomputes link flags / statuses on a live result (server computed them for its "today"). */
export function refreshLookup(result: ScanLookupResult, today: string, statusOf?: (childId: string) => ChildStatus): ScanLookupResult {
  if (result.kind === 'guardian') {
    return {
      ...result,
      children: result.children.map((c) => ({
        ...refreshChild(c, today, statusOf),
        relationship: c.relationship,
        relationshipLabel: c.relationshipLabel,
        canPickup: c.canPickup,
        blocked: c.blocked,
        pickupAllowedNow: pickupAllowed(c, today),
      })),
    };
  }
  const child = refreshChild(result.child, today, statusOf);
  return { ...result, child, guardians: child.guardians, authorizedPersons: child.authorizedPersons };
}

// ---- Search ----------------------------------------------------------------------

export interface SearchHit {
  ownerType: OwnerType;
  ownerId: string;
  name: string;
  photoUrl: string | null;
  /** "Turma A · Manhã" for children, "Mãe de Ana, Pedro" for guardians. */
  subtitle: string;
  className: string | null;
}

/** Name search over the directory (accent/case-insensitive), optionally filtered by class. */
export function searchDirectory(dir: ScanDirectory | null, query: string, className?: string | null, limit = 30): SearchHit[] {
  if (!dir) return [];
  const q = searchKey(query);
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const matches = (name: string) => {
    const key = searchKey(name);
    return terms.every((t) => key.includes(t));
  };
  const hits: SearchHit[] = [];
  const guardianChildren = new Map<string, { name: string; className: string | null; relationship: string }[]>();
  for (const child of dir.children) {
    if (!child.active) continue;
    for (const g of child.guardians) {
      const list = guardianChildren.get(g.id) ?? [];
      list.push({ name: child.name, className: child.className, relationship: g.relationshipLabel || relationshipLabel(g.relationship) });
      guardianChildren.set(g.id, list);
    }
  }
  for (const child of dir.children) {
    if (!child.active) continue;
    if (className && child.className !== className) continue;
    if (!matches(child.name)) continue;
    hits.push({
      ownerType: 'child',
      ownerId: child.id,
      name: child.name,
      photoUrl: child.photoUrl,
      subtitle: [child.className, child.shift ? shiftLabel(child.shift) : null].filter(Boolean).join(' · ') || 'Criança',
      className: child.className,
    });
  }
  for (const g of dir.guardians) {
    if (!g.active) continue;
    const kids = guardianChildren.get(g.id) ?? [];
    if (className && !kids.some((k) => k.className === className)) continue;
    if (!matches(g.name)) continue;
    const rel = kids[0]?.relationship;
    const names = kids.map((k) => k.name.split(' ')[0]);
    hits.push({
      ownerType: 'guardian',
      ownerId: g.id,
      name: g.name,
      photoUrl: g.photoUrl,
      subtitle: kids.length ? `${rel ?? 'Responsável'} de ${names.join(', ')}` : 'Responsável',
      className: kids[0]?.className ?? null,
    });
  }
  hits.sort((a, b) => {
    const sa = searchKey(a.name).startsWith(q) ? 0 : 1;
    const sb = searchKey(b.name).startsWith(q) ? 0 : 1;
    return sa - sb || a.name.localeCompare(b.name, 'pt-BR');
  });
  return hits.slice(0, limit);
}

function shiftLabel(shift: string): string {
  return shift === 'manha' ? 'Manhã' : shift === 'tarde' ? 'Tarde' : shift === 'integral' ? 'Integral' : shift;
}

/** Guardian/child display name lookup (for chips such as "Próximo: Fulano"). */
export function lookupDisplayName(result: ScanLookupResult): string {
  return result.kind === 'guardian' ? result.guardian.name : result.child.name;
}
