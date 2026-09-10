import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { NotificationDTO, NotificationKind } from '@creche/shared';
import { getMyNotifications, markNotificationsRead } from '../../api/endpoints';
import { describeError } from '../../api/client';
import { GuardianShell } from '../../components/AppShell';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Spinner } from '../../components/Spinner';
import { useFormat } from '../../lib/format';
import { LogoutButton } from '../LogoutButton';
import { AlertsBadge } from './AlertsBadge';

const PAGE = 30;
const MAX_AUTO_PAGES = 5;

const KIND_ICON: Record<NotificationKind, string> = {
  checkin: '🟢',
  checkout: '🟠',
  denied: '⛔',
  void: '↩️',
  guardian_added: '👤',
  authorization_added: '🤝',
  credential_revoked: '🪪',
  system: 'ℹ️',
};

export function AlertasPage() {
  const fmt = useFormat();
  const [params] = useSearchParams();
  const focusId = params.get('n');
  const [items, setItems] = useState<NotificationDTO[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [unread, setUnread] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [initialUnread, setInitialUnread] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const markedRef = useRef(false);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let page = await getMyNotifications({ limit: PAGE });
      let all = page.items;
      let cursor = page.nextBefore;
      // Deep link (?n=): keep paging until the target is loaded (bounded).
      let hops = 0;
      while (focusId && cursor && !all.some((n) => n.id === focusId) && hops < MAX_AUTO_PAGES) {
        page = await getMyNotifications({ limit: PAGE, before: cursor });
        all = [...all, ...page.items];
        cursor = page.nextBefore;
        hops++;
      }
      setItems(all);
      setNextBefore(cursor);
      setUnread(page.unreadCount);
      setInitialUnread(new Set(all.filter((n) => !n.readAt).map((n) => n.id)));
      if (!markedRef.current && page.unreadCount > 0) {
        markedRef.current = true;
        try {
          const r = await markNotificationsRead();
          setUnread(r.unreadCount);
        } catch {
          /* the badge will refresh on next open */
        }
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [focusId]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  useEffect(() => {
    if (!focusId || loading) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusId)}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.focus();
  }, [focusId, loading, items.length]);

  const loadMore = async () => {
    if (!nextBefore) return;
    setMore(true);
    try {
      const page = await getMyNotifications({ limit: PAGE, before: nextBefore });
      setItems((prev) => [...prev, ...page.items.filter((n) => !prev.some((p) => p.id === n.id))]);
      setNextBefore(page.nextBefore);
      setInitialUnread((prev) => {
        const next = new Set(prev);
        for (const n of page.items) if (!n.readAt) next.add(n.id);
        return next;
      });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setMore(false);
    }
  };

  return (
    <GuardianShell
      title="Alertas"
      headerActions={
        <>
          <AlertsBadge unread={unread} />
          <LogoutButton />
        </>
      }
    >
      <div className="stack">
        {error ? (
          <Banner
            kind="danger"
            actions={
              <Button variant="neutral" size="sm" onClick={() => void loadFirst()}>
                Tentar de novo
              </Button>
            }
          >
            {error}
          </Banner>
        ) : null}
        {loading ? <Spinner block label="Carregando alertas…" /> : null}
        {!loading && items.length === 0 && !error ? (
          <EmptyState icon="🔔" title="Nenhum alerta ainda">
            Você receberá aqui os avisos de entrada e saída dos seus filhos.
          </EmptyState>
        ) : null}
        <div className="list" data-testid="alerts-list" ref={listRef}>
          {items.map((n) => {
            const isFocus = n.id === focusId;
            const isNew = initialUnread.has(n.id);
            const cls = ['alert-item', n.override ? 'alert-item--override' : '', n.kind === 'denied' ? 'alert-item--denied' : '', isFocus ? 'alert-item--focus' : '', isNew ? 'alert-item--new' : '']
              .filter(Boolean)
              .join(' ');
            const childId = n.childIds[0] ?? n.events[0]?.childId ?? null;
            return (
              <article key={n.id} className={cls} data-id={n.id} data-testid="alert-item" data-kind={n.kind} data-override={n.override ? '1' : '0'} tabIndex={-1}>
                <div className="alert-item__head">
                  <span className="alert-item__icon" aria-hidden="true">
                    {n.override ? '⚠️' : KIND_ICON[n.kind]}
                  </span>
                  <span className="alert-item__title">{n.title}</span>
                  {isNew ? <span className="badge badge--info">novo</span> : null}
                </div>
                <p className="alert-item__body">{n.body}</p>
                <div className="row row--between">
                  <time className="tiny muted" dateTime={n.createdAt}>
                    {fmt.dateTime(n.createdAt)}
                  </time>
                  {childId ? (
                    <Link to={`/filho/${childId}`} className="small">
                      Ver histórico ›
                    </Link>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
        {nextBefore ? (
          <Button variant="neutral" onClick={() => void loadMore()} loading={more}>
            Carregar mais
          </Button>
        ) : null}
      </div>
    </GuardianShell>
  );
}
