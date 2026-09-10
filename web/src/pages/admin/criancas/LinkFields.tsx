import { RELATIONSHIPS, RELATIONSHIP_LABELS, type ChildGuardianBody, type Relationship } from '@creche/shared';
import { SimpleCheckbox } from '../../../components/CheckboxRow';
import { SelectField, TextArea, TextField } from '../../../components/TextField';
import type { FieldErrors } from '../../../lib/form';

export interface LinkValues {
  relationship: Relationship;
  canPickup: boolean;
  isPrimary: boolean;
  validFrom: string;
  validUntil: string;
  blocked: boolean;
  blockedReason: string;
}

export const DEFAULT_LINK: LinkValues = { relationship: 'mae', canPickup: true, isPrimary: false, validFrom: '', validUntil: '', blocked: false, blockedReason: '' };

export function linkBody(v: LinkValues): ChildGuardianBody {
  return {
    relationship: v.relationship,
    canPickup: v.canPickup,
    isPrimary: v.isPrimary,
    validFrom: v.validFrom || null,
    validUntil: v.validUntil || null,
    blocked: v.blocked,
    blockedReason: v.blocked ? v.blockedReason.trim() || null : null,
  };
}

/** The ChildGuardianBody fields (relationship, pickup, primary, validity, block). */
export function LinkFields({ value, onChange, errors }: { value: LinkValues; onChange: (v: LinkValues) => void; errors: FieldErrors }) {
  const set = <K extends keyof LinkValues>(k: K, val: LinkValues[K]) => onChange({ ...value, [k]: val });
  return (
    <div className="stack stack--sm">
      <SelectField label="Parentesco" value={value.relationship} onChange={(e) => set('relationship', e.target.value as Relationship)} error={errors.relationship}>
        {RELATIONSHIPS.map((r) => (
          <option key={r} value={r}>
            {RELATIONSHIP_LABELS[r]}
          </option>
        ))}
      </SelectField>
      <SimpleCheckbox checked={value.canPickup} onChange={(v) => set('canPickup', v)} label="Pode retirar a criança" testId="link-can-pickup" />
      <SimpleCheckbox checked={value.isPrimary} onChange={(v) => set('isPrimary', v)} label="Contato principal" />
      <div className="grid-2">
        <TextField label="Válido a partir de" type="date" value={value.validFrom} onChange={(e) => set('validFrom', e.target.value)} error={errors.validFrom} hint="Vazio = sem início" />
        <TextField label="Válido até" type="date" value={value.validUntil} min={value.validFrom || undefined} onChange={(e) => set('validUntil', e.target.value)} error={errors.validUntil} hint="Vazio = sem fim" />
      </div>
      <SimpleCheckbox checked={value.blocked} onChange={(v) => set('blocked', v)} tone="danger" label="BLOQUEADO — não liberar (decisão judicial / da direção)" testId="link-blocked" />
      {value.blocked ? (
        <TextArea label="Motivo do bloqueio (só administração)" value={value.blockedReason} onChange={(e) => set('blockedReason', e.target.value)} error={errors.blockedReason} rows={2} maxLength={500} />
      ) : null}
    </div>
  );
}
