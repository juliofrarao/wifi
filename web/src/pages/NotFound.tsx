import { Link } from 'react-router';
import { PublicShell } from '../components/AppShell';

export function NotFoundPage() {
  return (
    <PublicShell title="Página não encontrada">
      <p>
        <Link to="/">Voltar ao início</Link>
      </p>
    </PublicShell>
  );
}
