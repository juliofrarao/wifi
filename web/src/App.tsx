import { Navigate, Outlet, Route, Routes } from 'react-router';
import { HomeRedirect, RequireRole } from './auth/RequireRole';
import { GateProvider } from './gate/GateProvider';
import { ConfirmarPage } from './gate/pages/Confirmar';
import { FolhaPage } from './gate/pages/Folha';
import { HistoricoPage } from './gate/pages/Historico';
import { HojePage } from './gate/pages/Hoje';
import { LeituraPage } from './gate/pages/Leitura';
import { TrocarPage } from './gate/pages/Trocar';
import { AuditoriaPage } from './pages/admin/Auditoria';
import { CarteirinhasPage } from './pages/admin/Carteirinhas';
import { CarteirinhasImprimirPage } from './pages/admin/CarteirinhasImprimir';
import { ConfiguracoesPage } from './pages/admin/Configuracoes';
import { CriancaPage } from './pages/admin/criancas/Crianca';
import { CriancasPage } from './pages/admin/criancas/Criancas';
import { EquipePage } from './pages/admin/Equipe';
import { ImportarPage } from './pages/admin/Importar';
import { LancarPage } from './pages/admin/Lancar';
import { PainelPage } from './pages/admin/Painel';
import { RelatoriosPage } from './pages/admin/Relatorios';
import { ResponsaveisPage } from './pages/admin/Responsaveis';
import { ResponsavelPage } from './pages/admin/Responsavel';
import { AlertasPage } from './pages/guardian/Alertas';
import { ConfigPage } from './pages/guardian/Config';
import { FilhoPage } from './pages/guardian/Filho';
import { InicioPage } from './pages/guardian/Inicio';
import { NotFoundPage } from './pages/NotFound';
import { CardPublicPage } from './pages/public/CardPublic';
import { ForgotPage } from './pages/public/Forgot';
import { InvitePage } from './pages/public/Invite';
import { LoginPage } from './pages/public/Login';
import { ResetPage } from './pages/public/Reset';

function GateLayout() {
  return (
    <RequireRole roles={['guard', 'admin']}>
      <GateProvider>
        <Outlet />
      </GateProvider>
    </RequireRole>
  );
}

function GuardianLayout() {
  return (
    <RequireRole roles={['guardian']}>
      <Outlet />
    </RequireRole>
  );
}

function AdminLayout() {
  return (
    <RequireRole roles={['admin']}>
      <Outlet />
    </RequireRole>
  );
}

/** Routes exactly as spec §7. */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/esqueci" element={<ForgotPage />} />
      <Route path="/convite/:token" element={<InvitePage />} />
      <Route path="/redefinir/:token" element={<ResetPage />} />
      <Route path="/c/:code" element={<CardPublicPage />} />

      <Route path="/portaria" element={<GateLayout />}>
        <Route index element={<LeituraPage />} />
        <Route path="confirmar" element={<ConfirmarPage />} />
        <Route path="hoje" element={<HojePage />} />
        <Route path="historico" element={<HistoricoPage />} />
        <Route path="folha" element={<FolhaPage />} />
        <Route path="trocar" element={<TrocarPage />} />
        <Route path="*" element={<Navigate to="/portaria" replace />} />
      </Route>

      <Route element={<GuardianLayout />}>
        <Route path="/inicio" element={<InicioPage />} />
        <Route path="/alertas" element={<AlertasPage />} />
        <Route path="/filho/:id" element={<FilhoPage />} />
        <Route path="/config" element={<ConfigPage />} />
      </Route>

      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<PainelPage />} />
        <Route path="alertas" element={<AlertasPage admin />} />
        <Route path="criancas" element={<CriancasPage />} />
        <Route path="criancas/:id" element={<CriancaPage />} />
        <Route path="responsaveis" element={<ResponsaveisPage />} />
        <Route path="responsaveis/:id" element={<ResponsavelPage />} />
        <Route path="equipe" element={<EquipePage />} />
        <Route path="carteirinhas" element={<CarteirinhasPage />} />
        <Route path="carteirinhas/imprimir" element={<CarteirinhasImprimirPage />} />
        <Route path="relatorios" element={<RelatoriosPage />} />
        <Route path="lancar" element={<LancarPage />} />
        <Route path="importar" element={<ImportarPage />} />
        <Route path="auditoria" element={<AuditoriaPage />} />
        <Route path="configuracoes" element={<ConfiguracoesPage />} />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
