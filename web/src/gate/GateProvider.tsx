import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { todayCivil, type ChildStatus } from '@creche/shared';
import { useConfig } from '../config/ConfigProvider';
import { useToast } from '../components/Toast';
import { openGateChannel } from '../lib/broadcast';
import { STORAGE_KEYS, readString, writeString } from '../lib/storage';
import { VIBRATE, vibrate } from '../lib/vibrate';
import { directoryStore, installDirectoryWiring, loadDirectory, refreshDirectory, useDirectory, type DirectoryState } from './directory';
import { flowStore, isDuplicateRead, recentSuccessTime, setNext, setPending, setSuccess, setSwitchSuggested, useFlow, type PendingLookup, type SuccessInfo } from './flow';
import { hasAnyNfc, lookupDisplayName } from './lookup';
import { useNfcReader, type NfcReader } from './nfc';
import { installQueueTriggers, loadQueue } from './queue';
import { resolveCard, resolveOwner, type CardRead } from './resolve';
import { installStatusWiring, loadLocalEvents, localEventsStore, makeStatusResolver, presenceCounts, useLocalEvents } from './status';
import type { PresenceCounts } from './statusLogic';
import { installUndoWiring } from './undo';
import { SuccessOverlay } from './pages/Sucesso';

const HIDDEN_SWITCH_MS = 6 * 60 * 60 * 1000;

export interface GateContextValue {
  directory: DirectoryState;
  statusOf: (childId: string, base?: ChildStatus, baseAt?: string | null) => ChildStatus;
  counts: PresenceCounts;
  today: string;
  nfc: NfcReader;
  /** Show the NFC area (supported and the directory has at least one tag). */
  nfcVisible: boolean;
  /** Last reader message (errors) for the aria-live region. */
  readerMessage: string | null;
  setReaderMessage: (m: string | null) => void;
  /** Whether the last error suggests the name search. */
  suggestSearch: boolean;
  /** Resolves a read; returns true when a confirmation was opened (or queued as "next"). */
  handleRead: (read: CardRead) => Promise<boolean>;
  handleOwner: (ownerType: 'guardian' | 'child', ownerId: string) => Promise<boolean>;
  openLookup: (lookup: PendingLookup) => void;
  /** Confirmation finished: show success (if any), move on to "next" or back to Leitura. */
  finishConfirmation: (success: SuccessInfo | null) => void;
  cancelConfirmation: () => void;
  busy: boolean;
}

const GateContext = createContext<GateContextValue | null>(null);

export function GateProvider({ children }: { children: ReactNode }) {
  const { config } = useConfig();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const directory = useDirectory();
  const localEvents = useLocalEvents();
  const flow = useFlow();
  const [readerMessage, setReaderMessage] = useState<string | null>(null);
  const [suggestSearch, setSuggestSearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = todayCivil(config.timezone);

  // ---- Stores, triggers, wiring (once) ----
  useEffect(() => {
    installQueueTriggers();
    installStatusWiring();
    installDirectoryWiring();
    installUndoWiring();
    void Promise.all([loadDirectory(), loadQueue(), loadLocalEvents()]).then(() => refreshDirectory('open', true));
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        writeString(STORAGE_KEYS.gateHiddenAt, String(Date.now()));
      } else {
        void refreshDirectory('visibility');
        checkHidden();
      }
    };
    const checkHidden = () => {
      const raw = readString(STORAGE_KEYS.gateHiddenAt);
      if (!raw) return;
      writeString(STORAGE_KEYS.gateHiddenAt, null);
      if (Date.now() - Number(raw) > HIDDEN_SWITCH_MS) setSwitchSuggested(true);
    };
    checkHidden();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Directory version bump → refresh.
  const lastVersion = useRef<number | null>(null);
  useEffect(() => {
    if (lastVersion.current !== null && lastVersion.current !== config.directoryVersion) void refreshDirectory('version', true);
    lastVersion.current = config.directoryVersion;
  }, [config.directoryVersion]);

  // Switch suggested (returned after > 6 h hidden).
  useEffect(() => {
    if (flow.switchSuggested && location.pathname !== '/portaria/trocar') navigate('/portaria/trocar', { replace: false });
  }, [flow.switchSuggested, location.pathname, navigate]);

  // ---- Status resolver ----
  const statusOf = useMemo(
    () => makeStatusResolver(directory.directory, localEvents, today, config.timezone),
    [directory.directory, localEvents, today, config.timezone]
  );
  const counts = useMemo(() => presenceCounts(directory.directory, (id) => statusOf(id)), [directory.directory, statusOf]);

  /** Fresh deps for handlers (avoid stale closures in NFC/broadcast callbacks). */
  const depsNow = useCallback(() => {
    const dir = directoryStore.get().directory;
    const t = todayCivil(config.timezone);
    return { directory: dir, today: t, statusOf: makeStatusResolver(dir, localEventsStore.get(), t, config.timezone) };
  }, [config.timezone]);

  const openLookup = useCallback(
    (lookup: PendingLookup) => {
      const name = lookupDisplayName(lookup.result);
      const confirmOpen = window.location.pathname === '/portaria/confirmar' && flowStore.get().pending !== null;
      if (confirmOpen) {
        setNext(lookup);
        toast.show(`Próximo: ${name}`);
        return;
      }
      setSuccess(null);
      setPending(lookup);
      setReaderMessage(null);
      navigate('/portaria/confirmar');
    },
    [navigate, toast]
  );

  const handleRead = useCallback(
    async (read: CardRead) => {
      const readKey = read.uid || read.code || '';
      if (!readKey) return false;
      if ((read.method === 'nfc' || read.method === 'qr') && isDuplicateRead(readKey)) return false;
      vibrate(VIBRATE.read);
      setBusy(true);
      try {
        const outcome = await resolveCard(read, depsNow());
        if (outcome.kind === 'error') {
          setReaderMessage(outcome.message);
          setSuggestSearch(Boolean(outcome.suggestSearch));
          vibrate(VIBRATE.error);
          toast.show(outcome.message, 'danger');
          return false;
        }
        const t = recentSuccessTime(outcome.lookup.key);
        if (t) {
          toast.show(`Já registrado às ${t}`, 'warn');
          if (read.method === 'nfc' || read.method === 'qr') return false;
        }
        setSuggestSearch(false);
        openLookup(outcome.lookup);
        return true;
      } finally {
        setBusy(false);
      }
    },
    [depsNow, openLookup, toast]
  );

  const handleOwner = useCallback(
    async (ownerType: 'guardian' | 'child', ownerId: string) => {
      setBusy(true);
      try {
        const outcome = await resolveOwner(ownerType, ownerId, depsNow());
        if (outcome.kind === 'error') {
          setReaderMessage(outcome.message);
          toast.show(outcome.message, 'danger');
          return false;
        }
        openLookup(outcome.lookup);
        return true;
      } finally {
        setBusy(false);
      }
    },
    [depsNow, openLookup, toast]
  );

  const finishConfirmation = useCallback(
    (success: SuccessInfo | null) => {
      const { next } = flowStore.get();
      setPending(next);
      setNext(null);
      if (success) setSuccess(success);
      if (next) navigate('/portaria/confirmar', { replace: true });
      else navigate('/portaria', { replace: true });
    },
    [navigate]
  );

  const cancelConfirmation = useCallback(() => {
    const { next } = flowStore.get();
    setPending(next);
    setNext(null);
    if (next) navigate('/portaria/confirmar', { replace: true });
    else navigate('/portaria', { replace: true });
  }, [navigate]);

  // ---- NFC (active on every gate page; reads open the confirmation) ----
  const nfcVisible = hasAnyNfc(directory.directory);
  const nfc = useNfcReader({
    enabled: nfcVisible,
    onRead: (r) => void handleRead({ uid: r.uid, code: r.code, method: 'nfc' }),
    onError: (m) => {
      setReaderMessage(m);
      toast.show(m, 'danger');
    },
  });

  // ---- BroadcastChannel: codes from /c/:code in another tab ----
  useEffect(() => {
    const ch = openGateChannel();
    if (!ch) return;
    const unsub = ch.subscribe((msg) => {
      if (msg.type === 'ping') ch.post({ type: 'pong' });
      else if (msg.type === 'code') void handleRead({ code: msg.code, method: 'qr' });
    });
    return () => {
      unsub();
      ch.close();
    };
  }, [handleRead]);

  const value = useMemo<GateContextValue>(
    () => ({
      directory,
      statusOf,
      counts,
      today,
      nfc,
      nfcVisible,
      readerMessage,
      setReaderMessage,
      suggestSearch,
      handleRead,
      handleOwner,
      openLookup,
      finishConfirmation,
      cancelConfirmation,
      busy,
    }),
    [directory, statusOf, counts, today, nfc, nfcVisible, readerMessage, suggestSearch, handleRead, handleOwner, openLookup, finishConfirmation, cancelConfirmation, busy]
  );

  return (
    <GateContext.Provider value={value}>
      {children}
      {flow.success ? <SuccessOverlay info={flow.success} onClose={() => setSuccess(null)} /> : null}
    </GateContext.Provider>
  );
}

export function useGate(): GateContextValue {
  const ctx = useContext(GateContext);
  if (!ctx) throw new Error('useGate must be used inside <GateProvider>');
  return ctx;
}
