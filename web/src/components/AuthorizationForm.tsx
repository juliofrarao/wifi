import { useEffect, useMemo, useState } from 'react';
import { addDays, PickupAuthorizationBody, type PickupAuthorizationDTO } from '@creche/shared';
import { createPickupAuthorization } from '../api/endpoints';
import { useFormat } from '../lib/format';
import { emptyToNull, issuesFromError, formError, validateWith, type FieldErrors } from '../lib/form';
import { Banner } from './Banner';
import { Button } from './Button';
import { Modal } from './Modal';
import { SelectField, TextArea, TextField } from './TextField';

export const AUTHORIZATION_MAX_DAYS = 30;

/**
 * "Autorizar alguém a buscar" sheet (spec §3, §7). Used by guardians and by
 * the admin child page. `children` lets the caller offer a child picker.
 */
export function AuthorizationSheet({
  open,
  onClose,
  onCreated,
  childOptions,
  initialChildId,
  showDocument = true,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (auth: PickupAuthorizationDTO) => void;
  childOptions: { id: string; name: string }[];
  initialChildId?: string;
  showDocument?: boolean;
}) {
  const fmt = useFormat();
  const today = fmt.today();
  const [childId, setChildId] = useState(initialChildId ?? childOptions[0]?.id ?? '');
  const [personName, setPersonName] = useState('');
  const [personDocument, setPersonDocument] = useState('');
  const [relationshipLabel, setRelationshipLabel] = useState('');
  const [phone, setPhone] = useState('');
  const [validFrom, setValidFrom] = useState(today);
  const [validUntil, setValidUntil] = useState(today);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setChildId(initialChildId ?? childOptions[0]?.id ?? '');
    setPersonName('');
    setPersonDocument('');
    setRelationshipLabel('');
    setPhone('');
    setValidFrom(today);
    setValidUntil(today);
    setNote('');
    setErrors({});
    setError(null);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const maxUntil = useMemo(() => addDays(validFrom || today, AUTHORIZATION_MAX_DAYS), [validFrom, today]);
  const rangeError = validUntil && validFrom && validUntil > maxUntil ? `A autorização pode durar no máximo ${AUTHORIZATION_MAX_DAYS} dias.` : null;

  const submit = async () => {
    setError(null);
    const body = {
      personName: personName.trim(),
      personDocument: showDocument ? emptyToNull(personDocument) : null,
      relationshipLabel: relationshipLabel.trim(),
      phone: emptyToNull(phone),
      validFrom: validFrom || today,
      validUntil: validUntil || validFrom || today,
      note: emptyToNull(note),
    };
    const v = validateWith(PickupAuthorizationBody, body);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    if (rangeError) {
      setErrors({ validUntil: rangeError });
      return;
    }
    if (!childId) {
      setError('Escolha a criança.');
      return;
    }
    setBusy(true);
    try {
      const created = await createPickupAuthorization(childId, v.data);
      onCreated(created);
    } catch (err) {
      setErrors(issuesFromError(err));
      setError(formError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Autorizar alguém a buscar" sheet dismissible={!busy}>
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {childOptions.length > 1 ? (
          <SelectField label="Criança" value={childId} onChange={(e) => setChildId(e.target.value)}>
            {childOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectField>
        ) : childOptions.length === 1 ? (
          <p className="small">
            Criança: <strong>{childOptions[0].name}</strong>
          </p>
        ) : null}
        <TextField label="Nome completo de quem vai buscar" value={personName} onChange={(e) => setPersonName(e.target.value)} error={errors.personName} autoComplete="off" required />
        <TextField
          label="Relação com a criança"
          value={relationshipLabel}
          onChange={(e) => setRelationshipLabel(e.target.value)}
          placeholder="Ex.: vizinha, avó, tio"
          error={errors.relationshipLabel}
          required
        />
        <div className="grid-2">
          {showDocument ? (
            <TextField label="Documento (opcional)" value={personDocument} onChange={(e) => setPersonDocument(e.target.value)} error={errors.personDocument} hint="Só a administração vê." />
          ) : null}
          <TextField label="Telefone (opcional)" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={errors.phone} />
        </div>
        <div className="grid-2">
          <TextField
            label="Válida de"
            type="date"
            value={validFrom}
            min={today}
            onChange={(e) => {
              const v = e.target.value || today;
              setValidFrom(v);
              if (!validUntil || validUntil < v) setValidUntil(v);
            }}
            error={errors.validFrom}
          />
          <TextField label="Até" type="date" value={validUntil} min={validFrom || today} max={maxUntil} onChange={(e) => setValidUntil(e.target.value)} error={errors.validUntil ?? rangeError} />
        </div>
        <TextArea label="Observação (opcional)" value={note} onChange={(e) => setNote(e.target.value)} error={errors.note} rows={2} />
        <p className="tiny muted">A portaria só libera a criança para esta pessoa após conferir o documento. Os outros responsáveis serão avisados.</p>
        {error ? <Banner kind="danger">{error}</Banner> : null}
        <div className="sheet__actions">
          <Button variant="neutral" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Autorizar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Status badge for an authorization on the daycare's "today". */
export function authorizationBadge(auth: PickupAuthorizationDTO, today: string): { label: string; cls: string } {
  if (auth.revokedAt) return { label: 'revogada', cls: 'badge badge--danger' };
  if (auth.validNow || (auth.validFrom <= today && today <= auth.validUntil)) return { label: 'válida hoje', cls: 'badge badge--ok' };
  if (auth.validFrom > today) return { label: 'futura', cls: 'badge badge--info' };
  return { label: 'expirada', cls: 'badge' };
}
