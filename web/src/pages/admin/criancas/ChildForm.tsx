import { useState, type FormEvent } from 'react';
import { CONSENT_RELATIONSHIPS, CreateChildBody, RELATIONSHIP_LABELS, SHIFTS, SHIFT_LABELS, type ChildAdminDTO, type Relationship, type Shift } from '@creche/shared';
import { Banner } from '../../../components/Banner';
import { Button } from '../../../components/Button';
import { SelectField, TextArea, TextField } from '../../../components/TextField';
import { useFormat } from '../../../lib/format';
import { emptyToNull, issuesFromError, formError, validateWith, type FieldErrors } from '../../../lib/form';

export interface ChildFormValues {
  name: string;
  birthDate: string;
  className: string;
  shift: Shift | '';
  gateAlert: string;
  notes: string;
  consentAt: string;
  consentByName: string;
  consentRelationship: (typeof CONSENT_RELATIONSHIPS)[number] | '';
}

export function valuesFromChild(c: ChildAdminDTO | null): ChildFormValues {
  return {
    name: c?.name ?? '',
    birthDate: c?.birthDate ?? '',
    className: c?.className ?? '',
    shift: c?.shift ?? '',
    gateAlert: c?.gateAlert ?? '',
    notes: c?.notes ?? '',
    consentAt: c?.consentAt ?? '',
    consentByName: c?.consentByName ?? '',
    consentRelationship: (c?.consentRelationship as ChildFormValues['consentRelationship']) ?? '',
  };
}

export function bodyFromValues(v: ChildFormValues): CreateChildBody {
  return {
    name: v.name.trim(),
    birthDate: emptyToNull(v.birthDate),
    className: emptyToNull(v.className),
    shift: v.shift || null,
    gateAlert: emptyToNull(v.gateAlert),
    notes: emptyToNull(v.notes),
    consentAt: emptyToNull(v.consentAt),
    consentByName: emptyToNull(v.consentByName),
    consentRelationship: v.consentRelationship || null,
  };
}

/**
 * Create / edit form for a child (CreateChildBody fields + LGPD consent block).
 * Validation mirrors the shared zod schema; server issues map back to fields.
 */
export function ChildForm({
  initial,
  classOptions,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: ChildFormValues;
  classOptions: string[];
  submitLabel: string;
  onSubmit: (body: CreateChildBody) => Promise<void>;
  onCancel?: () => void;
}) {
  const fmt = useFormat();
  const [v, setV] = useState<ChildFormValues>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ChildFormValues>(key: K, value: ChildFormValues[K]) => setV((prev) => ({ ...prev, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = bodyFromValues(v);
    const result = validateWith(CreateChildBody, body);
    if (!result.ok) {
      setErrors(result.errors);
      setError(result.first);
      return;
    }
    const consentPartial = [body.consentAt, body.consentByName, body.consentRelationship].filter(Boolean).length;
    if (consentPartial > 0 && consentPartial < 3) {
      setErrors({ consentAt: 'Preencha data, nome e parentesco de quem assinou (ou deixe os três em branco).' });
      setError('Consentimento incompleto.');
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await onSubmit(result.data);
    } catch (err) {
      setErrors(issuesFromError(err));
      setError(formError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
      <TextField label="Nome completo" value={v.name} onChange={(e) => set('name', e.target.value)} error={errors.name} autoComplete="off" required data-testid="child-name" />
      <div className="grid-2">
        <TextField label="Data de nascimento" type="date" value={v.birthDate} max={fmt.today()} onChange={(e) => set('birthDate', e.target.value)} error={errors.birthDate} />
        <SelectField label="Turno" value={v.shift} onChange={(e) => set('shift', e.target.value as Shift | '')} error={errors.shift}>
          <option value="">—</option>
          {SHIFTS.map((s) => (
            <option key={s} value={s}>
              {SHIFT_LABELS[s]}
            </option>
          ))}
        </SelectField>
      </div>
      <TextField label="Turma" value={v.className} onChange={(e) => set('className', e.target.value)} error={errors.className} list="class-options" placeholder="Ex.: Maternal I" autoComplete="off" />
      <datalist id="class-options">
        {classOptions.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <TextField
        label="Aviso de portaria"
        value={v.gateAlert}
        onChange={(e) => set('gateAlert', e.target.value)}
        error={errors.gateAlert}
        maxLength={200}
        hint="Curto; a vigilante vê em vermelho. Ex.: “Não entregar ao pai — chamar a direção”."
      />
      <TextArea label="Observações (só administração)" value={v.notes} onChange={(e) => set('notes', e.target.value)} error={errors.notes} maxLength={2000} rows={3} />

      <fieldset className="fieldset">
        <legend className="fieldset__legend">Consentimento LGPD</legend>
        <p className="tiny muted">Quem assinou o termo de uso de dados e foto da criança (só mãe, pai ou responsável legal).</p>
        <div className="grid-2">
          <TextField label="Data" type="date" value={v.consentAt} max={fmt.today()} onChange={(e) => set('consentAt', e.target.value)} error={errors.consentAt} />
          <SelectField label="Parentesco" value={v.consentRelationship} onChange={(e) => set('consentRelationship', e.target.value as ChildFormValues['consentRelationship'])} error={errors.consentRelationship}>
            <option value="">—</option>
            {CONSENT_RELATIONSHIPS.map((r) => (
              <option key={r} value={r}>
                {RELATIONSHIP_LABELS[r as Relationship]}
              </option>
            ))}
          </SelectField>
        </div>
        <TextField label="Nome de quem assinou" value={v.consentByName} onChange={(e) => set('consentByName', e.target.value)} error={errors.consentByName} />
      </fieldset>

      {error ? <Banner kind="danger">{error}</Banner> : null}
      <div className="row">
        {onCancel ? (
          <Button variant="neutral" onClick={onCancel} disabled={busy}>
            Cancelar
          </Button>
        ) : null}
        <Button type="submit" variant="primary" loading={busy} data-testid="child-submit">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
