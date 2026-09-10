import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useConfig } from '../config/ConfigProvider';
import { UpdateBanner } from './UpdateBanner';

export interface NavItem {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

function Nav({ items }: { items: NavItem[] }) {
  return (
    <nav className="shell__nav no-print" aria-label="Navegação principal">
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end}>
          <span className="shell__nav-icon" aria-hidden="true">
            {item.icon}
          </span>
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * Generic shell: sticky header + bottom nav (side nav on wide screens when
 * `sideNavOnWide`). Pages render inside `.shell__main`.
 */
export function AppShell({
  title,
  brand,
  headerActions,
  nav,
  gate = false,
  sideNavOnWide = false,
  wide = false,
  flush = false,
  children,
}: {
  title: ReactNode;
  brand?: ReactNode;
  headerActions?: ReactNode;
  nav: NavItem[];
  gate?: boolean;
  sideNavOnWide?: boolean;
  wide?: boolean;
  flush?: boolean;
  children: ReactNode;
}) {
  const mainCls = ['shell__main', wide ? 'shell__main--wide' : '', flush ? 'shell__main--flush' : ''].filter(Boolean).join(' ');
  const body = (
    <>
      <header className={`shell__header${gate ? ' shell__header--gate' : ''}`}>
        <div className="grow">
          {brand ? <div className="shell__brand">{brand}</div> : null}
          <div className="shell__title">{title}</div>
        </div>
        {headerActions ? <div className="shell__header-actions">{headerActions}</div> : null}
      </header>
      <UpdateBanner />
      <main className={mainCls}>{children}</main>
    </>
  );
  if (sideNavOnWide) {
    return (
      <div className="shell shell--side">
        <Nav items={nav} />
        <div className="shell__body">{body}</div>
      </div>
    );
  }
  return (
    <div className="shell">
      {body}
      <Nav items={nav} />
    </div>
  );
}

export const GATE_NAV: NavItem[] = [
  { to: '/portaria', label: 'Leitura', icon: '📶', end: true },
  { to: '/portaria/hoje', label: 'Hoje', icon: '🏫' },
  { to: '/portaria/historico', label: 'Histórico', icon: '🗓️' },
  { to: '/portaria/folha', label: 'Folha', icon: '🖨️' },
];

/** Gate shell: dark header with the current guard's name and "Trocar". */
export function GateShell({ children, headerExtra, flush = false }: { children: ReactNode; headerExtra?: ReactNode; flush?: boolean }) {
  const { user } = useAuth();
  const { config } = useConfig();
  return (
    <AppShell
      gate
      brand={config.daycareName}
      title={<span data-testid="gate-guard-name">{user?.name ?? 'Portaria'}</span>}
      headerActions={
        <>
          {headerExtra}
          <Link to="/portaria/trocar" className="btn btn--sm btn--neutral" aria-label="Trocar vigilante">
            Trocar
          </Link>
        </>
      }
      nav={GATE_NAV}
      flush={flush}
    >
      {children}
    </AppShell>
  );
}

export const GUARDIAN_NAV: NavItem[] = [
  { to: '/inicio', label: 'Início', icon: '🏠' },
  { to: '/alertas', label: 'Alertas', icon: '🔔' },
  { to: '/config', label: 'Configurações', icon: '⚙️' },
];

export function GuardianShell({ children, title, headerActions }: { children: ReactNode; title?: ReactNode; headerActions?: ReactNode }) {
  const { config } = useConfig();
  return (
    <AppShell brand={config.daycareName} title={title ?? 'Meus filhos'} headerActions={headerActions} nav={GUARDIAN_NAV}>
      {children}
    </AppShell>
  );
}

export const ADMIN_NAV: NavItem[] = [
  { to: '/admin', label: 'Painel', icon: '📊', end: true },
  { to: '/admin/criancas', label: 'Crianças', icon: '🧒' },
  { to: '/admin/responsaveis', label: 'Responsáveis', icon: '👪' },
  { to: '/admin/equipe', label: 'Equipe', icon: '🛡️' },
  { to: '/admin/carteirinhas', label: 'Carteirinhas', icon: '🪪' },
  { to: '/admin/relatorios', label: 'Relatórios', icon: '📈' },
  { to: '/admin/lancar', label: 'Lançar folha', icon: '📝' },
  { to: '/admin/importar', label: 'Importar', icon: '📥' },
  { to: '/admin/auditoria', label: 'Auditoria', icon: '🔍' },
  { to: '/admin/configuracoes', label: 'Configurações', icon: '⚙️' },
];

export function AdminShell({ children, title, headerActions }: { children: ReactNode; title?: ReactNode; headerActions?: ReactNode }) {
  const { config } = useConfig();
  return (
    <AppShell brand={config.daycareName} title={title ?? 'Administração'} headerActions={headerActions} nav={ADMIN_NAV} sideNavOnWide wide>
      {children}
    </AppShell>
  );
}

/** Centered card layout for public pages (login, invite, reset). */
export function PublicShell({ children, title }: { children: ReactNode; title?: ReactNode }) {
  const { config } = useConfig();
  return (
    <div className="public-page">
      <div className="public-card">
        <div className="public-card__logo">
          <img src="/icons/icon-192.png" alt="" width={48} height={48} />
          <div>
            <div className="strong">{config.daycareName}</div>
            <div className="tiny muted">Creche Segura</div>
          </div>
        </div>
        {title ? <h1 className="mb">{title}</h1> : null}
        {children}
      </div>
      {config.demoData ? <p className="tiny muted mt">DADOS DE DEMONSTRAÇÃO</p> : null}
    </div>
  );
}
