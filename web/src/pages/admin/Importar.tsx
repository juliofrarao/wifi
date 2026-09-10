import { useRef, useState } from 'react';
import type { ImportResult, ImportRowResult } from '@creche/shared';
import { downloadImportTemplate, importCsv } from '../../api/endpoints';
import { describeError } from '../../api/client';
import { AdminShell } from '../../components/AppShell';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { saveBlob } from '../../lib/download';
import { LogoutButton } from '../LogoutButton';

const ACTION_LABEL: Record<ImportRowResult['action'], { label: string; cls: string }> = {
  create_child: { label: 'criar criança', cls: 'badge badge--ok' },
  link_existing: { label: 'vincular existente', cls: 'badge badge--info' },
  create_guardian: { label: 'criar responsável', cls: 'badge badge--ok' },
  skip: { label: 'ignorar', cls: 'badge' },
};

/** CSV import with dry-run preview (spec §4.10). */
export function ImportarPage() {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [committed, setCommitted] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<'template' | 'preview' | 'commit' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const template = async () => {
    setBusy('template');
    try {
      const { blob, filename } = await downloadImportTemplate();
      saveBlob(blob, filename ?? 'modelo-importacao.csv');
    } catch (err) {
      toast.show(describeError(err), 'danger', 5000);
    } finally {
      setBusy(null);
    }
  };

  const run = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(dryRun ? 'preview' : 'commit');
    setError(null);
    try {
      const result = await importCsv(file, dryRun);
      if (dryRun) {
        setPreview(result);
        setCommitted(null);
      } else {
        setCommitted(result);
        setPreview(null);
        setFile(null);
        if (fileRef.current) fileRef.current.value = '';
        toast.show(`Importação concluída: ${result.summary.childrenCreated} criança(s), ${result.summary.guardiansCreated} responsável(is), ${result.summary.linksCreated} vínculo(s).`, 'success', 8000);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const summary = (r: ImportResult) => (
    <div className="stat-grid stat-grid--compact">
      <div className="stat">
        <span className="stat__value">{r.summary.childrenCreated}</span>
        <span className="stat__label">crianças {r.dryRun ? 'a criar' : 'criadas'}</span>
      </div>
      <div className="stat">
        <span className="stat__value">{r.summary.guardiansCreated}</span>
        <span className="stat__label">responsáveis {r.dryRun ? 'a criar' : 'criados'}</span>
      </div>
      <div className="stat">
        <span className="stat__value">{r.summary.linksCreated}</span>
        <span className="stat__label">vínculos</span>
      </div>
      <div className="stat">
        <span className="stat__value">{r.summary.skipped}</span>
        <span className="stat__label">ignoradas</span>
      </div>
      <div className={`stat${r.summary.errors > 0 ? ' stat--danger' : ''}`}>
        <span className="stat__value">{r.summary.errors}</span>
        <span className="stat__label">com erro</span>
      </div>
    </div>
  );

  const table = (r: ImportResult) => (
    <div className="table-wrap">
      <table className="table" data-testid="import-preview">
        <thead>
          <tr>
            <th>Linha</th>
            <th>Ação</th>
            <th>Criança</th>
            <th>Responsável</th>
            <th>Erros</th>
          </tr>
        </thead>
        <tbody>
          {r.rows.map((row) => {
            const a = ACTION_LABEL[row.action];
            return (
              <tr key={row.line} className={row.errors.length > 0 ? 'table__row--danger' : ''}>
                <td>{row.line}</td>
                <td>
                  <span className={a.cls}>{a.label}</span>
                </td>
                <td>{row.childName}</td>
                <td>{row.guardianName ?? ''}</td>
                <td className="small">{row.errors.join('; ')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <AdminShell title="Importar planilha" headerActions={<LogoutButton />}>
      <div className="stack">
        <section className="card stack">
          <h2 className="card__title">1. Preencha o modelo</h2>
          <p className="small muted">
            CSV separado por ponto e vírgula (UTF-8), uma linha por par criança–responsável:{' '}
            <code>crianca;nascimento;turma;turno;resp_nome;resp_parentesco;resp_email;resp_telefone;pode_retirar;principal</code>. A criança casa por (nome, nascimento); o responsável por
            e-mail, senão por (nome, telefone). Importar não envia convites — use “Enviar convite” na página de cada responsável.
          </p>
          <Button variant="neutral" icon="⬇️" loading={busy === 'template'} onClick={() => void template()}>
            Baixar modelo (CSV)
          </Button>
        </section>

        <section className="card stack">
          <h2 className="card__title">2. Escolha o arquivo e pré-visualize</h2>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="field__input"
            aria-label="Arquivo CSV"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPreview(null);
              setCommitted(null);
              setError(null);
            }}
            data-testid="import-file"
          />
          <Button variant="primary" icon="🔍" loading={busy === 'preview'} disabled={!file} onClick={() => void run(true)} data-testid="import-preview-button">
            Pré-visualizar (nada é gravado)
          </Button>
          {error ? <Banner kind="danger">{error}</Banner> : null}
        </section>

        {preview ? (
          <section className="card stack">
            <h2 className="card__title">3. Confira e importe</h2>
            {summary(preview)}
            {preview.summary.errors > 0 ? <Banner kind="warn">Linhas com erro serão ignoradas. Corrija a planilha e pré-visualize de novo para importar tudo.</Banner> : null}
            {table(preview)}
            <Button
              variant="primary"
              size="big"
              icon="📥"
              loading={busy === 'commit'}
              disabled={!file || preview.rows.length === 0 || preview.rows.every((r) => r.action === 'skip' || r.errors.length > 0)}
              onClick={() => void run(false)}
              data-testid="import-commit"
            >
              Importar {preview.rows.filter((r) => r.errors.length === 0 && r.action !== 'skip').length} linha(s)
            </Button>
          </section>
        ) : null}

        {committed ? (
          <section className="card stack">
            <h2 className="card__title">Resultado da importação</h2>
            <Banner kind="success">Importação gravada.</Banner>
            {summary(committed)}
            {table(committed)}
          </section>
        ) : null}
      </div>
    </AdminShell>
  );
}
