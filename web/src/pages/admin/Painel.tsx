import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { AdminStats, AttendanceEventDTO } from '@creche/shared';
import { getAdminStats } from '../../api/endpoints';
import { AdminShell } from '../../components/AppShell';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { EventRow } from '../../components/EventRow';
import { QueryState } from '../../components/QueryState';
import { VoidEventDialog } from '../../components/VoidEventDialog';
import { useConfig } from '../../config/ConfigProvider';
import { formatDuration, useFormat } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { useNow } from '../../lib/useNow';
import { LogoutButton } from '../LogoutButton';

const REFRESH_MS = 60_000;
const BACKUP_RED_MS = 48 * 3600_000;
const QUEUE_RED_MS = 10 * 60_000;

function Stat({ label, value, sub, tone, to, testId }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'saida'; to?: string; testId?: string }) {
  const cls = `stat${tone ? ` stat--${tone}` : ''}`;
  const body = (
    <>
      <span className="stat__value" data-testid={testId}>
        {value}
      </span>
      <span className="stat__label">{label}</span>
      {sub ? <span className="stat__sub">{sub}</span> : null}
    </>
  );
  return to ? (
    <Link to={to} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function EventSection({ title, events, emptyText, onVoid }: { title: string; events: AttendanceEventDTO[]; emptyText: string; onVoid: (ev: AttendanceEventDTO) => void }) {
  return (
    <section className="card">
      <h2 className="card__title">
        {title} ({events.length})
      </h2>
      {events.length === 0 ? <p className="small muted">{emptyText}</p> : null}
      <div className="list">
        {events.map((ev) => (
          <EventRow key={ev.id} event={ev} childLink onVoid={ev.voidedAt ? undefined : onVoid} showDocument />
        ))}
      </div>
    </section>
  );
}

export function PainelPage() {
  const fmt = useFormat();
  const { config } = useConfig();
  const stats = useAsync(() => getAdminStats(), []);
  const now = useNow(30_000);
  const [voidFor, setVoidFor] = useState<AttendanceEventDTO | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') stats.reload();
    }, REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') stats.reload();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [stats.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const s: AdminStats | null = stats.data;
  const backupAge = s?.lastBackupAt ? now - Date.parse(s.lastBackupAt) : null;
  const backupRed = backupAge === null || backupAge > BACKUP_RED_MS;

  return (
    <AdminShell title="Painel" headerActions={<LogoutButton />}>
      <div className="stack">
        {config.demoData || s?.demoData ? (
          <Banner kind="warn" data-testid="demo-banner">
            DADOS DE DEMONSTRAÇÃO — este servidor contém dados fictícios. Rode <code>npm run seed -- --clean</code> antes de usar com dados reais.
          </Banner>
        ) : null}
        <div className="page-title">
          <h1>{fmt.civil(fmt.today())}</h1>
          <Button variant="neutral" size="sm" onClick={stats.reload} loading={stats.loading && s !== null}>
            Atualizar
          </Button>
        </div>
        <QueryState loading={stats.loading} error={stats.error} onRetry={stats.reload} hasData={s !== null}>
          {s ? (
            <div className="stack stack--lg">
              <div className="stat-grid">
                <Stat label="Na creche agora" value={s.presentNow} sub={s.stalePresentCount > 0 ? `+${s.stalePresentCount} sem saída ontem` : 'sem pendências de ontem'} tone="ok" to="/admin/criancas?f=na-creche" testId="stats-present" />
                <Stat label="Entradas hoje" value={s.checkinsToday} to="/admin/relatorios" />
                <Stat label="Saídas hoje" value={s.checkoutsToday} tone="saida" to="/admin/relatorios" />
                <Stat label="Crianças ativas" value={s.childrenActive} to="/admin/criancas" />
                <Stat label="Responsáveis ativos" value={s.guardiansActive} sub={`${s.guardiansWithoutAccess} sem acesso ao app`} to="/admin/responsaveis" />
                <Stat label="Sem responsável alcançável" value={s.childrenWithoutReachableGuardian} tone={s.childrenWithoutReachableGuardian > 0 ? 'danger' : undefined} to="/admin/criancas?f=sem-contato" />
                <Stat label="Sem consentimento LGPD" value={s.childrenWithoutConsent} tone={s.childrenWithoutConsent > 0 ? 'warn' : undefined} to="/admin/criancas?f=sem-consentimento" />
                <Stat
                  label="Último backup"
                  value={s.lastBackupAt ? fmt.dayMonth(s.lastBackupAt) : 'nunca'}
                  sub={s.lastBackupAt ? `${fmt.time(s.lastBackupAt)} · há ${formatDuration(backupAge ?? 0)}` : 'execute em Configurações'}
                  tone={backupRed ? 'danger' : 'ok'}
                  to="/admin/configuracoes"
                />
              </div>

              <div className="grid-2 grid-2--stack">
                <section className="card">
                  <h2 className="card__title">Portaria</h2>
                  {s.gate.length === 0 ? <p className="small muted">Nenhum celular de portaria conectado recentemente.</p> : null}
                  <div className="list">
                    {s.gate.map((g) => {
                      const queuedSince = g.oldestQueuedAt ? now - Date.parse(g.oldestQueuedAt) : 0;
                      const late = g.queuedCount > 0 && queuedSince > QUEUE_RED_MS;
                      return (
                        <div key={g.sessionId} className={`list-item${late ? ' list-item--danger' : ''}`}>
                          <span className="list-item__body">
                            <span className="list-item__title">{g.guardName}</span>
                            <span className="list-item__sub">
                              {g.queuedCount > 0 ? `${g.queuedCount} registro(s) pendente(s)${g.oldestQueuedAt ? ` desde ${fmt.time(g.oldestQueuedAt)}` : ''}` : 'fila vazia'} · visto {fmt.relative(g.at)}
                              {g.appVersion ? ` · versão ${g.appVersion}` : ''}
                            </span>
                          </span>
                          {g.queuedCount > 0 ? <span className={`badge ${late ? 'badge--danger' : 'badge--warn'}`}>{g.queuedCount} na fila</span> : <span className="badge badge--ok">ok</span>}
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="card">
                  <h2 className="card__title">E-mail e push</h2>
                  <ul className="kv">
                    <li>
                      <span>E-mail</span>
                      <span className={`badge ${s.notifications.emailEnabled ? 'badge--ok' : 'badge--warn'}`}>{s.notifications.emailEnabled ? 'ativo' : 'desligado'}</span>
                    </li>
                    <li>
                      <span>E-mails hoje</span>
                      <span className={s.notifications.emailsToday >= s.notifications.emailDailyLimit ? 'strong stat--danger-text' : ''}>
                        {s.notifications.emailsToday} / {s.notifications.emailDailyLimit}
                      </span>
                    </li>
                    <li>
                      <span>Push</span>
                      <span className={`badge ${s.notifications.pushEnabled ? 'badge--ok' : 'badge--warn'}`}>{s.notifications.pushEnabled ? 'configurado' : 'não configurado'}</span>
                    </li>
                    <li>
                      <span>Falhas nas últimas 24 h</span>
                      <span className={s.notifications.failedLast24h > 0 ? 'strong stat--danger-text' : ''}>{s.notifications.failedLast24h}</span>
                    </li>
                    <li>
                      <span>Puladas (cota) nas últimas 24 h</span>
                      <span>{s.notifications.skippedLast24h}</span>
                    </li>
                  </ul>
                </section>
              </div>

              <div className="grid-2 grid-2--stack">
                <section className="card">
                  <h2 className="card__title">Sem saída registrada ontem ({s.staleChildren.length})</h2>
                  {s.staleChildren.length === 0 ? <p className="small muted">Nenhuma pendência.</p> : null}
                  <div className="list">
                    {s.staleChildren.map((c) => (
                      <Link key={c.id} to={`/admin/criancas/${c.id}`} className="list-item">
                        <span className="list-item__body">
                          <span className="list-item__title">{c.name}</span>
                          <span className="list-item__sub">
                            {c.className ?? 'Sem turma'} · entrada {fmt.relative(c.status.since)}
                          </span>
                        </span>
                        <span className="badge badge--warn">sem saída</span>
                      </Link>
                    ))}
                  </div>
                </section>
                <section className="card">
                  <h2 className="card__title">Faltando há 5+ dias ({s.childrenAbsent5Days.length})</h2>
                  {s.childrenAbsent5Days.length === 0 ? <p className="small muted">Nenhuma criança.</p> : null}
                  <div className="list">
                    {s.childrenAbsent5Days.map((c) => (
                      <Link key={c.id} to={`/admin/criancas/${c.id}`} className="list-item">
                        <span className="list-item__body">
                          <span className="list-item__title">{c.name}</span>
                          <span className="list-item__sub">{c.className ?? 'Sem turma'}</span>
                        </span>
                        <span className="badge badge--warn">{c.absentStreakDays} dias</span>
                      </Link>
                    ))}
                  </div>
                </section>
              </div>

              <EventSection title="Exceções recentes" events={s.recentOverrides} emptyText="Nenhuma retirada fora da lista de autorizados." onVoid={setVoidFor} />
              <EventSection title="Conflitos da fila" events={s.recentConflicts} emptyText="Nenhum registro da fila em conflito." onVoid={setVoidFor} />
              <EventSection title="Tentativas recusadas" events={s.recentDenied} emptyText="Nenhuma recusa registrada." onVoid={setVoidFor} />
            </div>
          ) : null}
        </QueryState>
      </div>
      <VoidEventDialog
        event={voidFor}
        onClose={() => setVoidFor(null)}
        onVoided={() => {
          setVoidFor(null);
          stats.reload();
        }}
      />
    </AdminShell>
  );
}
