import { searchKey, type ChildAdminDTO, type Shift } from '@creche/shared';

/** Extra list filters reachable from the dashboard (`?f=`). */
export const CHILD_FLAGS = ['sem-contato', 'sem-consentimento', 'sem-foto', 'sem-carteirinha', 'na-creche', 'sem-saida'] as const;
export type ChildFlag = (typeof CHILD_FLAGS)[number];

export const CHILD_FLAG_LABELS: Record<ChildFlag, string> = {
  'sem-contato': 'Sem responsável alcançável',
  'sem-consentimento': 'Sem consentimento LGPD',
  'sem-foto': 'Sem foto',
  'sem-carteirinha': 'Sem carteirinha ativa',
  'na-creche': 'Na creche agora',
  'sem-saida': 'Sem saída registrada ontem',
};

export interface ChildFilter {
  q?: string;
  className?: string;
  shift?: Shift | '';
  flag?: ChildFlag | '';
  includeInactive?: boolean;
}

/** A guardian is "reachable" when at least one active, non-blocked link can get alerts. */
export function hasReachableGuardian(child: Pick<ChildAdminDTO, 'guardians'>): boolean {
  return child.guardians.some((g) => !g.blocked && g.reachable !== 'none');
}

export function hasConsent(child: Pick<ChildAdminDTO, 'consentAt' | 'consentByName'>): boolean {
  return Boolean(child.consentAt && child.consentByName);
}

export function matchesFlag(child: ChildAdminDTO, flag: ChildFlag | '' | undefined): boolean {
  switch (flag) {
    case 'sem-contato':
      return !hasReachableGuardian(child);
    case 'sem-consentimento':
      return !hasConsent(child);
    case 'sem-foto':
      return !child.photoUrl;
    case 'sem-carteirinha':
      return !child.credentials.some((c) => c.active);
    case 'na-creche':
      return child.status.present && !child.status.stale;
    case 'sem-saida':
      return child.status.present && child.status.stale;
    default:
      return true;
  }
}

/** Client-side filtering of the admin children list. */
export function filterChildren(children: ChildAdminDTO[], f: ChildFilter): ChildAdminDTO[] {
  const q = f.q ? searchKey(f.q) : '';
  return children
    .filter((c) => (f.includeInactive ? true : c.active))
    .filter((c) => (f.className ? c.className === f.className : true))
    .filter((c) => (f.shift ? c.shift === f.shift : true))
    .filter((c) => matchesFlag(c, f.flag))
    .filter((c) => {
      if (!q) return true;
      if (searchKey(c.name).includes(q)) return true;
      return c.guardians.some((g) => searchKey(g.name).includes(q));
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/** Distinct class names (sorted, pt-BR). */
export function classNames(children: { className: string | null }[]): string[] {
  const set = new Set<string>();
  for (const c of children) if (c.className) set.add(c.className);
  return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}
