import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Avatar } from '../../components/Avatar';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { GateShell } from '../../components/AppShell';
import { SelectField, TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useConfig } from '../../config/ConfigProvider';
import { codeHint, formatCodeInput } from '../../lib/codeField';
import { formatCountdown, useFormat } from '../../lib/format';
import { useNow } from '../../lib/useNow';
import { useWakeLock } from '../../lib/wakeLock';
import { getRecentPeople, refreshDirectory, rememberRecentPerson } from '../directory';
import { getSavedMode, saveMode, useFlow, type GateMode } from '../flow';
import { useGate } from '../GateProvider';
import { classNamesOf, searchDirectory } from '../lookup';
import { kickQueue, useQueue } from '../queue';
import { useQrScanner } from '../qr';
import { performUndo, undoActive, useUndo } from '../undo';
import { forgetSuccess } from '../flow';

const NFC_TEXT: Record<string, { title: string; hint: string }> = {
  idle: { title: 'Toque para ativar o leitor', hint: 'Depois, aproxime a carteirinha do celular.' },
  listening: { title: 'Aproxime a carteirinha', hint: 'Leitor NFC ativo.' },
  paused: { title: 'Leitor pausado', hint: 'Volte para o app para continuar lendo.' },
  off: { title: 'NFC desligado', hint: 'Ligue o NFC nas configurações do celular e toque aqui.' },
  blocked: { title: 'NFC bloqueado para este site', hint: 'Nas permissões do site (cadeado na barra de endereço), permita o NFC e toque aqui.' },
  unsupported: { title: 'NFC indisponível', hint: 'Use o QR Code, o código ou a busca por nome.' },
};

export function LeituraPage() {
  const gate = useGate();
  const flow = useFlow();
  const { config, updateAvailable, applyUpdate } = useConfig();
  const fmt = useFormat();
  const toast = useToast();
  const queue = useQueue();
  const undo = useUndo();
  const now = useNow(1000);
  const [searchParams, setSearchParams] = useSearchParams();
  const [mode, setMode] = useState<GateMode>(() => getSavedMode() ?? 'code');
  useWakeLock(true);

  // ---- ?code= from /c/:code in the same tab ----
  useEffect(() => {
    const code = searchParams.get('code');
    if (!code) return;
    setSearchParams({}, { replace: true });
    void gate.handleRead({ code, method: 'qr' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Idle auto-update: only here, with empty queue, no confirmation/undo/success open ----
  const idle = queue.counts.waiting === 0 && !flow.pending && !flow.success && !undoActive(undo, now);
  useEffect(() => {
    if (!updateAvailable || !idle) return;
    const t = setTimeout(() => void applyUpdate(), 2500);
    return () => clearTimeout(t);
  }, [updateAvailable, idle, applyUpdate]);

  const chooseMode = (m: GateMode) => {
    setMode(m);
    saveMode(m);
  };

  const nfcState = gate.nfc.state;
  const nfcText = NFC_TEXT[nfcState] ?? NFC_TEXT.idle;
  const nfcLive = nfcState === 'listening' ? 'Leitor NFC ativo. Aproxime a carteirinha.' : nfcState === 'paused' ? 'Leitor NFC pausado.' : '';

  const undoRemaining = undo ? Date.parse(undo.undoUntil) - now : 0;
  const showUndo = undoActive(undo, now);

  const handleUndo = async () => {
    const r = await performUndo();
    toast.show(r.message, r.ok ? 'success' : 'danger');
    if (r.ok) forgetSuccess();
  };

  return (
    <GateShell>
      <div className="visually-hidden" aria-live="polite">
        {nfcLive} {gate.readerMessage ?? ''}
      </div>

      <div className="stack">
        {queue.counts.needsLogin > 0 ? (
          <Banner kind="warn">Entre novamente para enviar {queue.counts.needsLogin} registro(s).</Banner>
        ) : null}
        {gate.directory.directory === null ? (
          gate.directory.loading ? (
            <Banner kind="info" icon="⏳">
              Baixando o diretório da creche…
            </Banner>
          ) : (
            <Banner
              kind="danger"
              actions={
                <Button variant="neutral" size="sm" onClick={() => void refreshDirectory('manual', true)}>
                  Tentar de novo
                </Button>
              }
            >
              Sem diretório local. {gate.directory.error ?? 'Conecte-se à internet para baixar os cadastros.'}
            </Banner>
          )
        ) : null}

        <div className="gate-counter" data-testid="gate-present-count" aria-live="polite">
          <span className="gate-counter__n">{gate.counts.present}</span> na creche
          {gate.counts.stale > 0 ? <span className="muted"> (+{gate.counts.stale} sem saída ontem)</span> : ''}
        </div>

        <div className="gate-chips">
          {queue.counts.waiting > 0 ? (
            <button
              type="button"
              className={`chip chip--tap ${queue.late ? 'chip--danger' : 'chip--warn'}`}
              data-testid="queue-chip"
              onClick={() => {
                kickQueue('manual', true);
                toast.show('Enviando registros…');
              }}
              aria-label={`${queue.counts.waiting} registros aguardando envio. Enviar agora.`}
            >
              {queue.counts.waiting} aguardando envio · Enviar agora
            </button>
          ) : (
            <span className="chip chip--success" data-testid="queue-ok">
              Tudo enviado ✓
            </span>
          )}
          {showUndo && undo ? (
            <button type="button" className="chip chip--tap chip--info" onClick={() => void handleUndo()} data-testid="undo-chip">
              Desfazer último registro ({formatCountdown(undoRemaining)})
            </button>
          ) : null}
          {queue.notApplied.length > 0 ? (
            <span className="chip chip--danger">{queue.notApplied.length} não aplicado(s) — veja em Hoje</span>
          ) : null}
        </div>

        {gate.readerMessage ? (
          <Banner
            kind="danger"
            actions={
              <>
                {gate.suggestSearch ? (
                  <Button variant="neutral" size="sm" onClick={() => chooseMode('search')}>
                    Buscar por nome
                  </Button>
                ) : null}
                <Button variant="neutral" size="sm" onClick={() => gate.setReaderMessage(null)}>
                  Fechar
                </Button>
              </>
            }
          >
            {gate.readerMessage}
          </Banner>
        ) : null}

        {gate.nfcVisible ? (
          <button
            type="button"
            className={`nfc-area ${nfcState === 'listening' ? 'nfc-area--listening' : nfcState === 'off' || nfcState === 'blocked' ? 'nfc-area--error' : ''}`}
            onClick={() => void gate.nfc.start()}
            disabled={nfcState === 'listening'}
            aria-label={nfcText.title}
          >
            {nfcState === 'listening' ? (
              <div className="pulse" aria-hidden="true">
                ))
              </div>
            ) : null}
            <div className="nfc-area__title">{nfcText.title}</div>
            <div className="nfc-area__hint">{nfcText.hint}</div>
          </button>
        ) : null}

        <div className="mode-buttons" role="tablist" aria-label="Modo de leitura">
          <Button variant="neutral" icon="📷" aria-pressed={mode === 'qr'} onClick={() => chooseMode('qr')} role="tab">
            Ler QR Code
          </Button>
          <Button variant="neutral" icon="⌨️" aria-pressed={mode === 'code'} onClick={() => chooseMode('code')} role="tab">
            Digitar código
          </Button>
          <Button variant="neutral" icon="🔍" aria-pressed={mode === 'search'} onClick={() => chooseMode('search')} role="tab" data-testid="gate-search-button">
            Buscar por nome
          </Button>
        </div>

        {mode === 'qr' ? <QrPanel /> : null}
        {mode === 'code' ? <CodePanel /> : null}
        {mode === 'search' ? <SearchPanel /> : null}

        {config.demoData ? <p className="tiny muted center">DADOS DE DEMONSTRAÇÃO</p> : null}
        <p className="tiny muted center">
          Diretório: {gate.directory.fetchedAt ? `atualizado ${fmt.relative(gate.directory.fetchedAt)}` : 'não baixado'}
          {' · '}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void refreshDirectory('manual', true)}>
            Atualizar
          </button>
        </p>
      </div>
    </GateShell>
  );
}

function QrPanel() {
  const gate = useGate();
  const qr = useQrScanner({ onCode: (raw) => void gate.handleRead({ code: raw, method: 'qr' }) });
  const start = qr.start;
  useEffect(() => {
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="card stack">
      <div className="qr-wrap">
        <video ref={qr.videoRef} className="qr-video" playsInline muted aria-label="Câmera para leitura de QR Code" />
        {qr.state === 'scanning' ? <div className="qr-frame" aria-hidden="true" /> : null}
      </div>
      {qr.state === 'starting' ? <p className="muted center">Abrindo a câmera…</p> : null}
      {qr.state === 'scanning' ? <p className="muted center">Aponte a câmera para o QR Code da carteirinha.</p> : null}
      {qr.state === 'idle' ? (
        <>
          {qr.timedOut ? <p className="muted center">Câmera fechada após 30 s sem leitura.</p> : null}
          <Button variant="primary" size="big" onClick={() => void qr.start()}>
            Ligar a câmera
          </Button>
        </>
      ) : null}
      {qr.state === 'denied' ? (
        <Banner kind="danger">
          A câmera está bloqueada para este site. Toque no cadeado na barra de endereço, permita a câmera e tente de novo.
          <span className="banner__actions">
            <Button variant="neutral" size="sm" onClick={() => void qr.start()}>
              Tentar de novo
            </Button>
          </span>
        </Banner>
      ) : null}
      {qr.state === 'unavailable' ? <Banner kind="warn">Nenhuma câmera disponível neste aparelho. Use o código ou a busca por nome.</Banner> : null}
      {qr.state === 'error' ? (
        <Banner kind="danger">
          Não foi possível abrir a câmera.
          <span className="banner__actions">
            <Button variant="neutral" size="sm" onClick={() => void qr.start()}>
              Tentar de novo
            </Button>
          </span>
        </Banner>
      ) : null}
    </div>
  );
}

function CodePanel() {
  const gate = useGate();
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const state = formatCodeInput(raw);
  const hint = codeHint(state);
  const submitting = useRef(false);

  const submit = useCallback(
    async (code: string) => {
      if (submitting.current) return;
      submitting.current = true;
      try {
        const opened = await gate.handleRead({ code, method: 'code' });
        if (opened) setRaw('');
      } finally {
        submitting.current = false;
      }
    },
    [gate]
  );

  return (
    <div className="card stack">
      <TextField
        autoFocus
        label="Código da carteirinha"
        inputClassName="field__input--code"
        value={state.display}
        onChange={(e) => {
          const next = formatCodeInput(e.target.value);
          setRaw(next.normalized);
          setError(null);
          if (next.valid) void submit(next.normalized);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (state.valid) void submit(state.normalized);
            else if (state.complete) setError('Código inválido. Confira os caracteres na carteirinha.');
            else setError('Digite os 8 caracteres do código.');
          }
        }}
        placeholder="XXXX-XXXX"
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        inputMode="text"
        enterKeyHint="go"
        maxLength={9}
        hint={hint ?? 'Digite as 8 letras/números impressos na carteirinha. O envio é automático.'}
        error={error ?? (state.complete && !state.valid ? 'Código inválido: contém caracteres que não existem nas carteirinhas.' : null)}
        data-testid="gate-code-input"
      />
      <Button variant="primary" size="big" disabled={!state.valid || gate.busy} loading={gate.busy} onClick={() => void submit(state.normalized)}>
        Buscar carteirinha
      </Button>
    </div>
  );
}

function SearchPanel() {
  const gate = useGate();
  const [query, setQuery] = useState('');
  const [className, setClassName] = useState('');
  const classes = useMemo(() => classNamesOf(gate.directory.directory), [gate.directory.directory]);
  const hits = useMemo(() => searchDirectory(gate.directory.directory, query, className || null), [gate.directory.directory, query, className]);
  const recent = useMemo(() => getRecentPeople(), []);

  const pick = (ownerType: 'guardian' | 'child', ownerId: string, name: string) => {
    rememberRecentPerson({ ownerType, ownerId, name });
    void gate.handleOwner(ownerType, ownerId);
  };

  return (
    <div className="card stack">
      <TextField
        autoFocus
        label="Nome da criança ou do responsável"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Ex.: Ana, Maria Silva"
        autoComplete="off"
        autoCorrect="off"
        inputMode="search"
        data-testid="gate-search-input"
      />
      {classes.length > 0 ? (
        <SelectField label="Turma" value={className} onChange={(e) => setClassName(e.target.value)}>
          <option value="">Todas as turmas</option>
          {classes.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </SelectField>
      ) : null}
      <div className="list search-results" role="list" aria-label="Resultados">
        {query.trim() === '' ? (
          recent.length > 0 ? (
            <>
              <div className="section-title">Recentes neste aparelho</div>
              {recent.map((r) => (
                <button key={`${r.ownerType}:${r.ownerId}`} type="button" className="list-item" onClick={() => pick(r.ownerType, r.ownerId, r.name)} data-testid={`gate-search-result-${r.ownerId}`}>
                  <span className="list-item__body">
                    <span className="list-item__title">{r.name}</span>
                    <span className="list-item__sub">{r.ownerType === 'child' ? 'Criança' : 'Responsável'}</span>
                  </span>
                </button>
              ))}
            </>
          ) : (
            <p className="muted small center">Digite parte do nome. A busca ignora acentos e maiúsculas.</p>
          )
        ) : hits.length === 0 ? (
          <p className="muted small center">Ninguém encontrado com “{query}”.</p>
        ) : (
          hits.map((h) => (
            <button key={`${h.ownerType}:${h.ownerId}`} type="button" className="list-item" onClick={() => pick(h.ownerType, h.ownerId, h.name)} data-testid={`gate-search-result-${h.ownerId}`}>
              <Avatar name={h.name} photoUrl={h.photoUrl} size="md" />
              <span className="list-item__body">
                <span className="list-item__title">{h.name}</span>
                <span className="list-item__sub">{h.subtitle}</span>
              </span>
              <span className={`badge ${h.ownerType === 'child' ? 'badge--info' : ''}`}>{h.ownerType === 'child' ? 'Criança' : 'Responsável'}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
