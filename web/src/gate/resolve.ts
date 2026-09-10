/**
 * Card resolution: local directory first (code / uid), then POST /scan/lookup
 * (3 s). Returns a PendingLookup or a user-facing error.
 */
import { normalizeCode, normalizeUid, type ChildStatus, type Method, type ScanDirectory, type ScanLookupResult } from '@creche/shared';
import { isApiError } from '../api/client';
import { manualLookup, scanLookup } from '../api/endpoints';
import { buildLookupFromDirectory, findCredential, refreshLookup } from './lookup';
import type { PendingLookup } from './flow';

export interface ResolveDeps {
  directory: ScanDirectory | null;
  today: string;
  statusOf: (childId: string) => ChildStatus;
}

export type ResolveOutcome =
  | { kind: 'ok'; lookup: PendingLookup }
  | { kind: 'error'; message: string; suggestSearch?: boolean };

export interface CardRead {
  code?: string | null;
  uid?: string | null;
  method: Method;
}

export function pendingFromResult(result: ScanLookupResult, read: { method: Method; code?: string | null; uid?: string | null }, source: 'directory' | 'live'): PendingLookup {
  const ownerId = result.kind === 'guardian' ? result.guardian.id : result.child.id;
  return {
    id: crypto.randomUUID(),
    result,
    method: read.method,
    credentialId: result.credentialId,
    source,
    readAt: new Date().toISOString(),
    code: read.code ? normalizeCode(read.code) : null,
    uid: read.uid ? normalizeUid(read.uid) : null,
    key: result.credentialId ?? `${result.kind}:${ownerId}`,
  };
}

export const MESSAGES = {
  revoked: 'Carteirinha cancelada — avise a direção.',
  notFound: 'Carteirinha não reconhecida.',
  mismatch: 'Carteirinha inconsistente — avise a direção.',
  inactive: 'Pessoa desligada da creche — avise a direção.',
  offlineUnknown: 'Sem conexão e carteirinha fora do diretório local. Tente a busca por nome.',
};

export async function resolveCard(read: CardRead, deps: ResolveDeps): Promise<ResolveOutcome> {
  const code = read.code ? normalizeCode(read.code) : null;
  const uid = read.uid ? normalizeUid(read.uid) : null;
  if (!code && !uid) return { kind: 'error', message: MESSAGES.notFound, suggestSearch: true };

  const match = findCredential(deps.directory, { code, uid });
  if (match.mismatch) return { kind: 'error', message: MESSAGES.mismatch };
  if (match.credential) {
    if (!match.credential.active) return { kind: 'error', message: MESSAGES.revoked };
    const built = buildLookupFromDirectory(deps.directory!, match.credential.ownerType, match.credential.ownerId, deps.today, {
      matchedBy: match.matchedBy ?? 'code',
      credentialId: match.credential.id,
      statusOf: deps.statusOf,
    });
    if (built.ok) return { kind: 'ok', lookup: pendingFromResult(built.result, { method: read.method, code, uid }, 'directory') };
    if (built.reason === 'inactive') return { kind: 'error', message: MESSAGES.inactive };
    // Owner missing from the directory: fall through to the live lookup.
  }

  try {
    const result = await scanLookup({ ...(code ? { code } : {}), ...(uid ? { uid } : {}) }, { timeoutMs: 3000 });
    return { kind: 'ok', lookup: pendingFromResult(refreshLookup(result, deps.today, deps.statusOf), { method: read.method, code, uid }, 'live') };
  } catch (err) {
    if (isApiError(err)) {
      switch (err.code) {
        case 'CARD_NOT_FOUND':
          return { kind: 'error', message: MESSAGES.notFound, suggestSearch: true };
        case 'CARD_REVOKED':
          return { kind: 'error', message: MESSAGES.revoked };
        case 'OWNER_INACTIVE':
          return { kind: 'error', message: MESSAGES.inactive };
        case 'CREDENTIAL_MISMATCH':
          return { kind: 'error', message: MESSAGES.mismatch };
        case 'NETWORK':
        case 'TIMEOUT':
          return { kind: 'error', message: MESSAGES.offlineUnknown, suggestSearch: true };
        default:
          return { kind: 'error', message: err.message, suggestSearch: err.status === 404 };
      }
    }
    return { kind: 'error', message: MESSAGES.offlineUnknown, suggestSearch: true };
  }
}

/** Search result → lookup (directory first, POST /scan/manual as fallback). */
export async function resolveOwner(ownerType: 'guardian' | 'child', ownerId: string, deps: ResolveDeps): Promise<ResolveOutcome> {
  if (deps.directory) {
    const built = buildLookupFromDirectory(deps.directory, ownerType, ownerId, deps.today, { matchedBy: 'search', credentialId: null, statusOf: deps.statusOf });
    if (built.ok) return { kind: 'ok', lookup: pendingFromResult(built.result, { method: 'search' }, 'directory') };
    if (built.reason === 'inactive') return { kind: 'error', message: MESSAGES.inactive };
  }
  try {
    const result = await manualLookup({ ownerType, ownerId }, { timeoutMs: 3000 });
    return { kind: 'ok', lookup: pendingFromResult(refreshLookup(result, deps.today, deps.statusOf), { method: 'search' }, 'live') };
  } catch (err) {
    return { kind: 'error', message: isApiError(err) ? err.message : 'Não foi possível localizar a pessoa.' };
  }
}
