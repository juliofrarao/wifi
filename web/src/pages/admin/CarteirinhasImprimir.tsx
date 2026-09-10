import { useMemo } from 'react';
import { Link, useLocation } from 'react-router';
import type { ChildAdminDTO } from '@creche/shared';
import { CARDS_PER_PAGE, buildPrintCards, chunk, parsePrintQuery, type PrintCard } from '../../admin/cards';
import { listChildren, listCredentials, listUsers } from '../../api/endpoints';
import { AdminShell } from '../../components/AppShell';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { QrCodeImage } from '../../components/QrCodeImage';
import { QueryState } from '../../components/QueryState';
import { useConfig } from '../../config/ConfigProvider';
import { useAsync } from '../../lib/useAsync';

/**
 * /admin/carteirinhas/imprimir?ids=…|className=…&photo=1 — A4 sheets of CR80
 * cards (85.6 × 54 mm, 10 per page) with short name, class, daycare name and
 * phone, code ≥ 14 pt, QR ≥ 3 cm and an NFC sticker area (spec §4.7).
 */
export function CarteirinhasImprimirPage() {
  const { search } = useLocation();
  const { config } = useConfig();
  const query = useMemo(() => parsePrintQuery(search), [search]);
  const data = useAsync(async () => {
    const creds = query.ids.length > 0 ? await listCredentials({}) : await listCredentials({ className: query.className ?? undefined });
    const wanted = query.ids.length > 0 ? creds.filter((c) => query.ids.includes(c.id)) : creds;
    const photos = new Map<string, string | null>();
    if (query.photo) {
      const [children, guardians] = await Promise.all([listChildren<ChildAdminDTO>({ includeInactive: true }), listUsers({ role: 'guardian', includeInactive: true })]);
      for (const c of children) photos.set(`child:${c.id}`, c.photoUrl);
      for (const g of guardians) photos.set(`guardian:${g.id}`, g.photoUrl);
    }
    const ordered = [...wanted].sort((a, b) => (a.ownerClassName ?? '').localeCompare(b.ownerClassName ?? '', 'pt-BR') || a.ownerName.localeCompare(b.ownerName, 'pt-BR'));
    return buildPrintCards(ordered, config.appUrl, photos, query.photo);
  }, [search, config.appUrl]);
  const pages = useMemo(() => chunk(data.data ?? [], CARDS_PER_PAGE), [data.data]);

  return (
    <AdminShell title="Imprimir carteirinhas">
      <div className="stack">
        <div className="row row--between no-print">
          <Link to="/admin/carteirinhas" className="btn btn--ghost">
            ‹ Carteirinhas
          </Link>
          <Button variant="primary" icon="🖨️" onClick={() => window.print()} disabled={!data.data || data.data.length === 0}>
            Imprimir
          </Button>
        </div>
        <Banner kind="info" className="banner--compact no-print">
          Papel A4, sem margens extras, escala 100 %. Recorte pelas linhas e plastifique fosco. Cada cartão tem 85,6 × 54 mm (padrão CR80); a área tracejada recebe a etiqueta NFC.
        </Banner>
        <QueryState loading={data.loading} error={data.error} onRetry={data.reload} hasData={data.data !== null}>
          {data.data && data.data.length === 0 ? <Banner kind="warn">Nenhuma carteirinha ativa com código para imprimir.</Banner> : null}
          <p className="tiny muted no-print">
            {data.data?.length ?? 0} cartão(ões) · {pages.length} folha(s)
          </p>
          <div className="cards-print">
            {pages.map((page, i) => (
              <section key={i} className="cards-page print-page" aria-label={`Folha ${i + 1}`}>
                {page.map((card) => (
                  <Cr80Card key={card.id} card={card} daycareName={config.daycareName} daycarePhone={config.daycarePhone} />
                ))}
              </section>
            ))}
          </div>
        </QueryState>
      </div>
    </AdminShell>
  );
}

function Cr80Card({ card, daycareName, daycarePhone }: { card: PrintCard; daycareName: string; daycarePhone: string | null }) {
  return (
    <article className="cr80" data-testid={`print-card-${card.id}`}>
      <header className="cr80__head">
        <span className="cr80__daycare">{daycareName}</span>
        {daycarePhone ? <span className="cr80__phone">{daycarePhone}</span> : null}
      </header>
      <div className="cr80__body">
        <div className="cr80__qr">
          <QrCodeImage value={card.url} size={360} alt={`QR Code ${card.codeText}`} />
        </div>
        <div className="cr80__info">
          {card.photoUrl ? <img className="cr80__photo" src={card.photoUrl} alt="" /> : null}
          <div className="cr80__name" title={card.fullName}>
            {card.displayName}
          </div>
          <div className="cr80__meta">{card.ownerType === 'child' ? (card.className ?? 'Criança') : 'Responsável'}</div>
          <div className="cr80__code">{card.codeText}</div>
          <div className="cr80__nfc" aria-hidden="true">
            NFC
          </div>
        </div>
      </div>
      <footer className="cr80__foot">Se encontrar esta carteirinha, ligue para a creche. {card.url.replace(/^https?:\/\//, '')}</footer>
    </article>
  );
}
