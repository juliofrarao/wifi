import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { SHIFT_LABELS, type ChildAdminDTO } from '@creche/shared';
import { anonymizeChild, getChild, listChildren, listPickupAuthorizations, updateChild, uploadChildPhoto } from '../../../api/endpoints';
import { describeError } from '../../../api/client';
import { classNames, hasConsent, hasReachableGuardian } from '../../../admin/childFilters';
import { AdminShell } from '../../../components/AppShell';
import { Avatar } from '../../../components/Avatar';
import { Banner } from '../../../components/Banner';
import { Button } from '../../../components/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { OwnerCredentials } from '../../../components/OwnerCredentials';
import { PhotoUpload } from '../../../components/PhotoUpload';
import { QueryState } from '../../../components/QueryState';
import { Tabs } from '../../../components/Tabs';
import { useToast } from '../../../components/Toast';
import { useFormat } from '../../../lib/format';
import { useAsync } from '../../../lib/useAsync';
import { LogoutButton } from '../../LogoutButton';
import { AuthorizationsTab } from './AuthorizationsTab';
import { AuthorizedPrint } from './AuthorizedPrint';
import { ChildForm, valuesFromChild } from './ChildForm';
import { childStatusBadge } from './Criancas';
import { GuardiansTab } from './GuardiansTab';
import { HistoryTab } from './HistoryTab';

const TABS = ['dados', 'foto', 'responsaveis', 'autorizacoes', 'carteirinhas', 'historico', 'mais'] as const;
type Tab = (typeof TABS)[number];

export function CriancaPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const fmt = useFormat();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(tabParam ?? '') ? (tabParam as Tab) : 'dados';
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };
  const child = useAsync(() => getChild<ChildAdminDTO>(id), [id]);
  const others = useAsync(() => listChildren<ChildAdminDTO>({}), []);
  const classes = useMemo(() => classNames(others.data ?? []), [others.data]);
  const [printing, setPrinting] = useState(false);
  const printAuths = useAsync(() => (printing ? listPickupAuthorizations(id, true) : Promise.resolve([])), [id, printing]);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [anonymizeOpen, setAnonymizeOpen] = useState(false);
  const c = child.data;

  if (printing && c) {
    return (
      <AdminShell title={`Autorizados — ${c.name}`}>
        <AuthorizedPrint child={c} authorizations={printAuths.data ?? []} onBack={() => setPrinting(false)} />
      </AdminShell>
    );
  }

  const st = c ? childStatusBadge(c) : null;

  return (
    <AdminShell
      title={c?.name ?? 'Criança'}
      headerActions={
        <>
          <Link to="/admin/criancas" className="btn btn--ghost btn--sm">
            ‹ Crianças
          </Link>
          <LogoutButton />
        </>
      }
    >
      <QueryState loading={child.loading} error={child.error} onRetry={child.reload} hasData={c !== null}>
        {c ? (
          <div className="stack">
            <div className="card row">
              <Avatar name={c.name} photoUrl={c.photoUrl} size="lg" noPhotoBadge />
              <div className="grow">
                <div className="big-text">{c.name}</div>
                <div className="small muted">
                  {c.className ?? 'Sem turma'}
                  {c.shift ? ` · ${SHIFT_LABELS[c.shift]}` : ''}
                  {c.birthDate ? ` · nascimento ${fmt.civil(c.birthDate)}` : ''}
                </div>
                <div className="row mt">
                  {st ? <span className={st.cls}>{st.label}</span> : null}
                  {c.status.present && c.status.since ? <span className="tiny muted">desde {fmt.relative(c.status.since)}</span> : null}
                  {!hasReachableGuardian(c) ? <span className="badge badge--danger">sem responsável alcançável</span> : null}
                  {!hasConsent(c) ? <span className="badge badge--warn">sem consentimento</span> : null}
                  {c.anonymizedAt ? <span className="badge badge--danger">anonimizada</span> : null}
                </div>
              </div>
            </div>
            {c.gateAlert ? <Banner kind="danger">Aviso de portaria: {c.gateAlert}</Banner> : null}
            {!c.active ? <Banner kind="warn">Criança desativada{c.deactivatedAt ? ` em ${fmt.dateTime(c.deactivatedAt)}` : ''}. Não aparece na portaria nem nos relatórios.</Banner> : null}

            <Tabs<Tab>
              items={[
                { key: 'dados', label: 'Dados' },
                { key: 'foto', label: 'Foto' },
                { key: 'responsaveis', label: 'Responsáveis', badge: c.guardians.length },
                { key: 'autorizacoes', label: 'Autorizações', badge: c.authorizations.filter((a) => !a.revokedAt).length || undefined },
                { key: 'carteirinhas', label: 'Carteirinhas', badge: c.credentials.filter((k) => k.active).length || undefined },
                { key: 'historico', label: 'Histórico' },
                { key: 'mais', label: 'Mais' },
              ]}
              value={tab}
              onChange={setTab}
            />

            {tab === 'dados' ? (
              <div className="card">
                <ChildForm
                  key={c.id}
                  initial={valuesFromChild(c)}
                  classOptions={classes}
                  submitLabel="Salvar"
                  onSubmit={async (body) => {
                    const updated = await updateChild(c.id, body);
                    child.setData(updated);
                    toast.show('Dados salvos.', 'success');
                  }}
                />
              </div>
            ) : null}

            {tab === 'foto' ? (
              <div className="card">
                <PhotoUpload
                  name={c.name}
                  photoUrl={c.photoUrl}
                  square
                  upload={(form) => uploadChildPhoto(c.id, form)}
                  onUploaded={(url) => child.setData({ ...c, photoUrl: url })}
                  hint="A foto da criança aparece na tela da portaria e, opcionalmente, na carteirinha."
                />
              </div>
            ) : null}

            {tab === 'responsaveis' ? <GuardiansTab child={c} onChanged={(updated) => child.setData(updated)} /> : null}
            {tab === 'autorizacoes' ? <AuthorizationsTab child={c} onChanged={child.reload} /> : null}
            {tab === 'carteirinhas' ? (
              <div className="stack">
                <p className="small muted">Carteirinha da criança: qualquer pessoa da lista de autorizados pode usá-la; a portaria escolhe quem está presente.</p>
                <OwnerCredentials owner={{ type: 'child', id: c.id, name: c.name }} onChanged={child.reload} />
              </div>
            ) : null}
            {tab === 'historico' ? <HistoryTab childId={c.id} onChanged={child.reload} /> : null}

            {tab === 'mais' ? (
              <div className="stack">
                <section className="card stack">
                  <h2 className="card__title">Impressão</h2>
                  <Button variant="neutral" icon="🖨️" onClick={() => setPrinting(true)}>
                    Imprimir lista de autorizados
                  </Button>
                </section>
                <section className="card stack">
                  <h2 className="card__title">{c.active ? 'Desativar' : 'Reativar'}</h2>
                  <p className="small muted">
                    {c.active
                      ? 'Criança que saiu da creche. Se estiver presente, uma saída automática é registrada. Os dados ficam guardados (nada é apagado).'
                      : 'Volta a aparecer na portaria e nos relatórios.'}
                  </p>
                  <Button variant={c.active ? 'danger' : 'primary'} onClick={() => setDeactivateOpen(true)} data-testid="child-deactivate">
                    {c.active ? 'Desativar criança' : 'Reativar criança'}
                  </Button>
                </section>
                <section className="card stack">
                  <h2 className="card__title">Anonimizar (LGPD)</h2>
                  <p className="small muted">
                    Substitui o nome por “Criança removida #NNNN”, apaga nascimento, observações e foto e revoga as carteirinhas. Os eventos ficam. Só para crianças desativadas; não pode ser
                    desfeito.
                  </p>
                  <Button variant="danger" disabled={c.active || Boolean(c.anonymizedAt)} onClick={() => setAnonymizeOpen(true)}>
                    {c.anonymizedAt ? 'Já anonimizada' : 'Anonimizar'}
                  </Button>
                </section>
                <p className="tiny muted">Cadastrada em {fmt.dateTime(c.createdAt)}.</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </QueryState>

      <ConfirmDialog
        open={deactivateOpen}
        title={c?.active ? 'Desativar criança' : 'Reativar criança'}
        confirmLabel={c?.active ? 'Desativar' : 'Reativar'}
        variant={c?.active ? 'danger' : 'primary'}
        onCancel={() => setDeactivateOpen(false)}
        onConfirm={async () => {
          if (!c) return;
          try {
            const updated = await updateChild(c.id, { active: !c.active });
            child.setData(updated);
            toast.show(updated.active ? 'Criança reativada.' : 'Criança desativada.', 'success');
            setDeactivateOpen(false);
          } catch (err) {
            throw new Error(describeError(err));
          }
        }}
      >
        <p>{c?.active ? `${c.name} deixará de aparecer na portaria.` : `${c?.name} voltará a aparecer na portaria.`}</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={anonymizeOpen}
        title="Anonimizar criança"
        confirmLabel="Anonimizar definitivamente"
        reason={{ label: 'Motivo', minLength: 3, placeholder: 'Ex.: pedido da família / retenção' }}
        onCancel={() => setAnonymizeOpen(false)}
        onConfirm={async (reason) => {
          if (!c) return;
          try {
            await anonymizeChild(c.id, { reason });
            toast.show('Criança anonimizada.', 'success');
            setAnonymizeOpen(false);
            navigate('/admin/criancas');
          } catch (err) {
            throw new Error(describeError(err));
          }
        }}
      >
        <p>Esta ação não pode ser desfeita.</p>
      </ConfirmDialog>
    </AdminShell>
  );
}
