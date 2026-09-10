import { relationshipLabel, type BackfillBody, type ChildAdminDTO, type CreateEventsResult } from '@creche/shared';
import { isValidTime, zonedToIso } from '../lib/tz';

export const OTHER_PERSON = '__other__';

/** One option of the "who" dropdown: a linked guardian, a valid authorization or "other". */
export interface PersonOption {
  value: string;
  label: string;
  /** For links: guardianId; for authorizations: personName. */
  guardianId: string | null;
  personName: string | null;
  /** One-off authorization covering this person (sent so the pickup is not an exception). */
  authorizationId: string | null;
  /** Whether a checkout by this person is allowed without an exception (R2). */
  allowed: boolean;
}

export interface BackfillRowInput {
  childId: string;
  checkinTime: string;
  checkinWho: string;
  checkinOther: string;
  checkoutTime: string;
  checkoutWho: string;
  checkoutOther: string;
}

export function emptyRow(childId: string): BackfillRowInput {
  return { childId, checkinTime: '', checkinWho: '', checkinOther: '', checkoutTime: '', checkoutWho: '', checkoutOther: '' };
}

/** Who can appear in the dropdown for a child on a civil date. */
export function personOptions(child: ChildAdminDTO, date: string): PersonOption[] {
  const out: PersonOption[] = [];
  for (const g of child.guardians) {
    if (g.blocked) continue;
    const allowed = g.canPickup && (!g.validFrom || g.validFrom <= date) && (!g.validUntil || g.validUntil >= date);
    out.push({
      value: `g:${g.id}`,
      label: `${g.name} (${(g.relationshipLabel || relationshipLabel(g.relationship)).toLowerCase()})${allowed ? '' : ' — sem permissão para retirar'}`,
      guardianId: g.id,
      personName: null,
      authorizationId: null,
      allowed,
    });
  }
  for (const a of child.authorizations) {
    if (a.revokedAt) continue;
    if (a.validFrom > date || a.validUntil < date) continue;
    out.push({ value: `a:${a.id}`, label: `${a.personName} (${a.relationshipLabel}, autorização avulsa)`, guardianId: null, personName: a.personName, authorizationId: a.id, allowed: true });
  }
  out.push({ value: OTHER_PERSON, label: 'Outra pessoa (digitar nome) — exceção', guardianId: null, personName: null, authorizationId: null, allowed: false });
  return out;
}

export interface BuildResult {
  rows: BackfillBody['rows'];
  /** clientId → childId + type for result mapping. */
  index: Map<string, { childId: string; type: 'checkin' | 'checkout' }>;
  errors: Record<string, string>;
}

/**
 * Turns the grid into BackfillBody rows. Empty times are skipped; a filled
 * time without a person, an invalid time or checkout ≤ checkin is an error.
 */
export function buildBackfillRows(
  inputs: BackfillRowInput[],
  options: Map<string, PersonOption[]>,
  date: string,
  timeZone: string,
  note: string | null,
  newId: () => string
): BuildResult {
  const rows: BackfillBody['rows'] = [];
  const index = new Map<string, { childId: string; type: 'checkin' | 'checkout' }>();
  const errors: Record<string, string> = {};

  for (const input of inputs) {
    const opts = options.get(input.childId) ?? [];
    type Who = { guardianId: string | null; personName: string | null; authorizationId: string | null; allowed: boolean };
    const resolve = (who: string, other: string): Who | string => {
      if (!who) return 'Escolha quem deixou/retirou';
      if (who === OTHER_PERSON) {
        const name = other.trim();
        if (name.length < 2) return 'Digite o nome da pessoa';
        return { guardianId: null, personName: name, authorizationId: null, allowed: false };
      }
      const opt = opts.find((o) => o.value === who);
      if (!opt) return 'Pessoa inválida';
      return { guardianId: opt.guardianId, personName: opt.personName, authorizationId: opt.authorizationId, allowed: opt.allowed };
    };
    /** Checkout rows by someone without permission are exceptions and need a reason (≥ 10 chars). */
    const exception = (who: Who): { override: true; note: string } | string => {
      const reason = (note ?? '').trim();
      if (reason.length < 10) return 'Saída por pessoa sem permissão: escreva o motivo na observação (mínimo 10 caracteres)';
      return { override: true, note: reason };
    };

    let checkinIso: string | null = null;
    if (input.checkinTime.trim()) {
      if (!isValidTime(input.checkinTime)) {
        errors[`${input.childId}.checkin`] = 'Hora inválida (use HH:MM)';
      } else {
        const who = resolve(input.checkinWho, input.checkinOther);
        if (typeof who === 'string') errors[`${input.childId}.checkin`] = who;
        else {
          checkinIso = zonedToIso(date, input.checkinTime, timeZone);
          const clientId = newId();
          rows.push({ clientId, childId: input.childId, type: 'checkin', occurredAt: checkinIso, note, guardianId: who.guardianId, personName: who.personName });
          index.set(clientId, { childId: input.childId, type: 'checkin' });
        }
      }
    }
    if (input.checkoutTime.trim()) {
      if (!isValidTime(input.checkoutTime)) {
        errors[`${input.childId}.checkout`] = 'Hora inválida (use HH:MM)';
      } else if (checkinIso && input.checkinTime >= input.checkoutTime) {
        errors[`${input.childId}.checkout`] = 'A saída deve ser depois da entrada';
      } else {
        const who = resolve(input.checkoutWho, input.checkoutOther);
        if (typeof who === 'string') errors[`${input.childId}.checkout`] = who;
        else {
          const extra = who.allowed ? null : exception(who);
          if (typeof extra === 'string') errors[`${input.childId}.checkout`] = extra;
          else {
            const clientId = newId();
            rows.push({
              clientId,
              childId: input.childId,
              type: 'checkout',
              occurredAt: zonedToIso(date, input.checkoutTime, timeZone),
              note: extra ? extra.note : note,
              guardianId: who.guardianId,
              personName: who.personName,
              authorizationId: who.authorizationId,
              ...(extra ? { override: true } : {}),
            });
            index.set(clientId, { childId: input.childId, type: 'checkout' });
          }
        }
      }
    }
  }
  return { rows, index, errors };
}

export type RowOutcome = { status: 'created' | 'duplicate' | 'rejected'; message: string };

/** Maps the server result back onto `<childId>.<type>` keys. */
export function mapBackfillResults(result: CreateEventsResult, index: BuildResult['index']): Record<string, RowOutcome> {
  const out: Record<string, RowOutcome> = {};
  for (const r of result.results) {
    const key = index.get(r.clientId);
    if (!key) continue;
    const message =
      r.status === 'created'
        ? 'Lançado'
        : r.status === 'duplicate'
          ? 'Já existia (ignorado)'
          : (r.error?.message ?? 'Recusado');
    out[`${key.childId}.${key.type}`] = { status: r.status, message };
  }
  return out;
}
