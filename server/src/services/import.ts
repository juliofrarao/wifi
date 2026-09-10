/**
 * Spreadsheet import (spec §4.10). One CSV row per child–guardian pair:
 * crianca;nascimento;turma;turno;resp_nome;resp_parentesco;resp_email;resp_telefone;pode_retirar;principal
 *
 * `planImport` validates and matches rows against the database (and against
 * rows earlier in the same file); `applyImport` executes the plan in one
 * transaction. Never sends invites.
 */
import { randomUUID } from 'node:crypto';
import {
  type ImportResult,
  type ImportRowResult,
  type Relationship,
  type Shift,
  RELATIONSHIPS,
  RELATIONSHIP_LABELS,
  SHIFTS,
  SHIFT_LABELS,
  searchKey,
} from '@creche/shared';
import { type Db, all, run, tx } from '../db/index.js';
import { bumpDirectoryVersion } from '../db/settings.js';
import { type Actor, audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import { isValidCivilDate } from '../lib/time.js';
import { insertUser } from './users.js';
import { parseCsv, toCsv } from './csv.js';

export const IMPORT_COLUMNS = ['crianca', 'nascimento', 'turma', 'turno', 'resp_nome', 'resp_parentesco', 'resp_email', 'resp_telefone', 'pode_retirar', 'principal'] as const;
type Column = (typeof IMPORT_COLUMNS)[number];

export function importTemplateCsv(): string {
  return toCsv([
    [...IMPORT_COLUMNS],
    ['Ana Souza', '2022-03-15', 'Maternal I', 'manha', 'Maria Souza', 'mae', 'maria@exemplo.com.br', '(11) 91234-5678', 'sim', 'sim'],
    ['Ana Souza', '2022-03-15', 'Maternal I', 'manha', 'José Souza', 'pai', '', '(11) 99876-5432', 'sim', 'nao'],
    ['Pedro Lima', '15/08/2021', 'Maternal II', 'integral', 'Carla Lima', 'mae', 'carla@exemplo.com.br', '', 'sim', 'sim'],
  ]);
}

// ---------------------------------------------------------------------------
// Field parsing
// ---------------------------------------------------------------------------

const digits = (s: string) => s.replace(/[^0-9]/g, '');

function parseBirth(raw: string): { value: string | null; error?: string } {
  const s = raw.trim();
  if (!s) return { value: null };
  let civil = s;
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) civil = `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  if (!isValidCivilDate(civil)) return { value: null, error: `nascimento inválido: "${s}" (use AAAA-MM-DD ou DD/MM/AAAA)` };
  return { value: civil };
}

function parseShift(raw: string): { value: Shift | null; error?: string } {
  const s = searchKey(raw);
  if (!s) return { value: null };
  for (const shift of SHIFTS) {
    if (s === shift || s === searchKey(SHIFT_LABELS[shift])) return { value: shift };
  }
  return { value: null, error: `turno inválido: "${raw.trim()}" (use manha, tarde ou integral)` };
}

const relationshipByExact = new Map<string, Relationship>();
const relationshipByKey = new Map<string, Relationship>();
for (const r of RELATIONSHIPS) {
  relationshipByExact.set(r, r);
  relationshipByExact.set(RELATIONSHIP_LABELS[r].toLowerCase(), r);
  if (!relationshipByKey.has(searchKey(RELATIONSHIP_LABELS[r]))) relationshipByKey.set(searchKey(RELATIONSHIP_LABELS[r]), r);
  relationshipByKey.set(r, r);
}

function parseRelationship(raw: string): { value: Relationship | null; error?: string } {
  const exact = raw.trim().toLowerCase();
  if (!exact) return { value: null };
  const direct = relationshipByExact.get(exact);
  if (direct) return { value: direct };
  const loose = relationshipByKey.get(searchKey(raw));
  if (loose) return { value: loose };
  return { value: null, error: `parentesco inválido: "${raw.trim()}" (use ${RELATIONSHIPS.join(', ')})` };
}

function parseBool(raw: string, field: string, fallback: boolean): { value: boolean; error?: string } {
  const s = searchKey(raw);
  if (!s) return { value: fallback };
  if (['sim', 's', '1', 'true', 'x', 'yes'].includes(s)) return { value: true };
  if (['nao', 'n', '0', 'false', 'no'].includes(s)) return { value: false };
  return { value: fallback, error: `${field} inválido: "${raw.trim()}" (use sim ou nao)` };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

interface PlannedChild {
  key: string;
  id: string;
  name: string;
  birthDate: string | null;
  className: string | null;
  shift: Shift | null;
  isNew: boolean;
}

interface PlannedGuardian {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  isNew: boolean;
}

interface PlannedLink {
  childId: string;
  userId: string;
  relationship: Relationship;
  canPickup: boolean;
  isPrimary: boolean;
}

export interface ImportPlan extends ImportResult {
  ops: { children: PlannedChild[]; guardians: PlannedGuardian[]; links: PlannedLink[] };
}

export interface ExistingChild {
  id: string;
  name: string;
  birth_date: string | null;
}

function childKey(name: string): string {
  return searchKey(name);
}

export function planImport(db: Db, csv: Buffer | string, dryRun: boolean): ImportPlan {
  const rows = parseCsv(csv);
  if (rows.length === 0) throw new ApiError('VALIDATION', 'Arquivo vazio');
  const header = rows[0].map((h) => searchKey(h).replace(/\s+/g, '_'));
  const missing = IMPORT_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new ApiError('VALIDATION', `Cabeçalho inválido: faltam as colunas ${missing.join(', ')}`, {
      issues: missing.map((c) => ({ path: c, message: 'coluna ausente' })),
    });
  }
  const col = (r: string[], c: Column) => (r[header.indexOf(c)] ?? '').trim();

  // Existing data
  const existingChildren = all<ExistingChild>(db, 'SELECT id, name, birth_date FROM children WHERE anonymized_at IS NULL');
  const childrenByName = new Map<string, ExistingChild[]>();
  for (const c of existingChildren) {
    const list = childrenByName.get(childKey(c.name)) ?? [];
    list.push(c);
    childrenByName.set(childKey(c.name), list);
  }
  const existingUsers = all<{ id: string; name: string; email: string | null; phone: string | null; role: string }>(
    db,
    'SELECT id, name, email, phone, role FROM users WHERE anonymized_at IS NULL'
  );
  const usersByEmail = new Map(existingUsers.filter((u) => u.email).map((u) => [u.email!.toLowerCase(), u]));
  const guardiansByNamePhone = new Map<string, { id: string; name: string }>();
  for (const u of existingUsers) {
    if (u.role !== 'guardian') continue;
    const key = `${searchKey(u.name)}|${digits(u.phone ?? '')}`;
    if (!guardiansByNamePhone.has(key)) guardiansByNamePhone.set(key, u);
  }
  const liveLinks = new Set(all<{ child_id: string; user_id: string }>(db, 'SELECT child_id, user_id FROM child_guardians WHERE removed_at IS NULL').map((l) => `${l.child_id}|${l.user_id}`));

  // Plan
  const newChildren: PlannedChild[] = [];
  const newGuardians: PlannedGuardian[] = [];
  const links: PlannedLink[] = [];
  const results: ImportRowResult[] = [];
  const plannedChildren = new Map<string, PlannedChild>(); // key = name|birth
  const plannedGuardiansByEmail = new Map<string, PlannedGuardian>();
  const plannedGuardiansByNamePhone = new Map<string, PlannedGuardian>();
  const plannedLinks = new Set<string>();

  const findChild = (name: string, birth: string | null): PlannedChild | null => {
    const key = childKey(name);
    const planned = plannedChildren.get(`${key}|${birth ?? ''}`) ?? [...plannedChildren.values()].find((c) => c.key === key && (!birth || !c.birthDate || c.birthDate === birth));
    if (planned) return planned;
    const candidates = childrenByName.get(key) ?? [];
    const match = candidates.find((c) => !birth || !c.birth_date || c.birth_date === birth);
    if (!match) return null;
    const pc: PlannedChild = { key, id: match.id, name: match.name, birthDate: match.birth_date, className: null, shift: null, isNew: false };
    plannedChildren.set(`${key}|${match.birth_date ?? ''}`, pc);
    return pc;
  };

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 1;
    const errors: string[] = [];
    const childName = col(r, 'crianca');
    const guardianName = col(r, 'resp_nome');
    const result: ImportRowResult = { line, action: 'skip', childName, guardianName: guardianName || null, errors };

    if (childName.length < 2) errors.push('crianca: nome obrigatório');
    const birth = parseBirth(col(r, 'nascimento'));
    if (birth.error) errors.push(birth.error);
    const shift = parseShift(col(r, 'turno'));
    if (shift.error) errors.push(shift.error);
    const className = col(r, 'turma') || null;

    let relationship: Relationship | null = null;
    let email: string | null = null;
    let phone: string | null = null;
    let canPickup = true;
    let isPrimary = false;
    if (guardianName) {
      if (guardianName.length < 2) errors.push('resp_nome: nome muito curto');
      const rel = parseRelationship(col(r, 'resp_parentesco'));
      if (rel.error) errors.push(rel.error);
      else if (!rel.value) errors.push('resp_parentesco: obrigatório quando há responsável');
      relationship = rel.value;
      const rawEmail = col(r, 'resp_email').toLowerCase();
      if (rawEmail) {
        if (!EMAIL_RE.test(rawEmail)) errors.push(`resp_email inválido: "${rawEmail}"`);
        else email = rawEmail;
      }
      phone = col(r, 'resp_telefone') || null;
      const pick = parseBool(col(r, 'pode_retirar'), 'pode_retirar', true);
      if (pick.error) errors.push(pick.error);
      canPickup = pick.value;
      const primary = parseBool(col(r, 'principal'), 'principal', false);
      if (primary.error) errors.push(primary.error);
      isPrimary = primary.value;
    }

    if (errors.length) {
      results.push(result);
      continue;
    }

    // Child
    let child = findChild(childName, birth.value);
    let childCreated = false;
    if (!child) {
      child = { key: childKey(childName), id: randomUUID(), name: childName, birthDate: birth.value, className, shift: shift.value, isNew: true };
      plannedChildren.set(`${child.key}|${birth.value ?? ''}`, child);
      newChildren.push(child);
      childCreated = true;
    }

    if (!guardianName) {
      result.action = childCreated ? 'create_child' : 'skip';
      if (!childCreated) errors.push('criança já cadastrada e sem responsável na linha');
      results.push(result);
      continue;
    }

    // Guardian
    let guardian: PlannedGuardian | null = null;
    let guardianCreated = false;
    const namePhoneKey = `${searchKey(guardianName)}|${digits(phone ?? '')}`;
    if (email) {
      const existing = usersByEmail.get(email);
      if (existing) {
        if (existing.role !== 'guardian') {
          errors.push(`resp_email pertence a um usuário da equipe (${existing.role})`);
          results.push(result);
          continue;
        }
        guardian = { id: existing.id, name: existing.name, email, phone: existing.phone, isNew: false };
      } else {
        guardian = plannedGuardiansByEmail.get(email) ?? null;
      }
    }
    if (!guardian) {
      const existing = guardiansByNamePhone.get(namePhoneKey);
      if (existing) guardian = { id: existing.id, name: existing.name, email: null, phone, isNew: false };
      else guardian = plannedGuardiansByNamePhone.get(namePhoneKey) ?? null;
    }
    if (!guardian) {
      guardian = { id: randomUUID(), name: guardianName, email, phone, isNew: true };
      if (email) plannedGuardiansByEmail.set(email, guardian);
      plannedGuardiansByNamePhone.set(namePhoneKey, guardian);
      newGuardians.push(guardian);
      guardianCreated = true;
    }

    // Link
    const linkKey = `${child.id}|${guardian.id}`;
    if (liveLinks.has(linkKey) || plannedLinks.has(linkKey)) {
      result.action = childCreated ? 'create_child' : guardianCreated ? 'create_guardian' : 'skip';
      if (result.action === 'skip') errors.push('vínculo já existe');
      results.push(result);
      continue;
    }
    plannedLinks.add(linkKey);
    links.push({ childId: child.id, userId: guardian.id, relationship: relationship!, canPickup, isPrimary });
    result.action = childCreated ? 'create_child' : guardianCreated ? 'create_guardian' : 'link_existing';
    results.push(result);
  }

  return {
    dryRun,
    rows: results,
    summary: {
      childrenCreated: newChildren.length,
      guardiansCreated: newGuardians.length,
      linksCreated: links.length,
      skipped: results.filter((r) => r.action === 'skip').length,
      errors: results.filter((r) => r.errors.length > 0).length,
    },
    ops: { children: newChildren, guardians: newGuardians, links },
  };
}

export function applyImport(db: Db, plan: ImportPlan, actor: Actor, ip: string | null, now: Date): ImportResult {
  const iso = now.toISOString();
  tx(db, () => {
    for (const c of plan.ops.children) {
      run(
        db,
        `INSERT INTO children (id, name, birth_date, class_name, shift, gate_alert, notes, photo_file_id, active, deactivated_at,
           consent_at, consent_by_name, consent_relationship, anonymized_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        c.id,
        c.name,
        c.birthDate,
        c.className,
        c.shift,
        iso,
        iso
      );
    }
    for (const g of plan.ops.guardians) {
      insertUser(db, { id: g.id, name: g.name, email: g.email, phone: g.phone, role: 'guardian', now });
    }
    for (const l of plan.ops.links) {
      if (l.isPrimary) run(db, 'UPDATE child_guardians SET is_primary = 0 WHERE child_id = ? AND removed_at IS NULL', l.childId);
      run(
        db,
        `INSERT INTO child_guardians (id, child_id, user_id, relationship, can_pickup, is_primary, valid_from, valid_until, blocked, blocked_reason,
           created_by, created_at, updated_by, updated_at, removed_at, removed_by)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?, ?, ?, NULL, NULL)`,
        randomUUID(),
        l.childId,
        l.userId,
        l.relationship,
        l.canPickup ? 1 : 0,
        l.isPrimary ? 1 : 0,
        actor.id,
        iso,
        actor.id,
        iso
      );
    }
    audit(db, actor, 'import.commit', 'import', null, plan.summary, ip, now);
    if (plan.ops.children.length || plan.ops.guardians.length || plan.ops.links.length) bumpDirectoryVersion(db);
  });
  return { dryRun: false, rows: plan.rows, summary: plan.summary };
}
