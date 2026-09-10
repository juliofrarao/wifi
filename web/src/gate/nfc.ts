import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeUid, parseCardContent } from '@creche/shared';
import { VIBRATE, vibrate } from '../lib/vibrate';

/**
 * Web NFC reader state machine (spec §4.1):
 *  unsupported (no NDEFReader) · off (NotReadableError) · blocked (NotAllowedError
 *  after a user gesture) · idle (needs a tap to start) · listening · paused (hidden).
 */
export type NfcState = 'unsupported' | 'off' | 'blocked' | 'idle' | 'listening' | 'paused';

export interface NfcRead {
  uid: string | null;
  code: string | null;
}

export interface NfcReader {
  state: NfcState;
  /** Starts scanning (call from a user gesture when state is idle/blocked/off). */
  start: () => Promise<void>;
  stop: () => void;
  supported: boolean;
}

const DUP_MS = 2000;

function decodeRecord(record: NDEFRecord): string | null {
  if (!record.data) return null;
  try {
    if (record.recordType === 'url' || record.recordType === 'absolute-url') {
      return new TextDecoder().decode(record.data);
    }
    if (record.recordType === 'text') {
      return new TextDecoder(record.encoding || 'utf-8').decode(record.data);
    }
    if (record.recordType === 'mime' && record.mediaType?.startsWith('text/')) {
      return new TextDecoder().decode(record.data);
    }
  } catch {
    return null;
  }
  return null;
}

export function useNfcReader(opts: { enabled: boolean; onRead: (read: NfcRead) => void; onError: (message: string) => void }): NfcReader {
  const supported = typeof window !== 'undefined' && 'NDEFReader' in window;
  const [state, setState] = useState<NfcState>(supported ? 'idle' : 'unsupported');
  const controller = useRef<AbortController | null>(null);
  const lastRead = useRef<{ key: string; at: number } | null>(null);
  const onReadRef = useRef(opts.onRead);
  const onErrorRef = useRef(opts.onError);
  onReadRef.current = opts.onRead;
  onErrorRef.current = opts.onError;

  const stop = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState((s) => (s === 'listening' ? 'idle' : s));
  }, []);

  const startInternal = useCallback(
    async (userGesture: boolean) => {
      if (!supported) return;
      controller.current?.abort();
      const ac = new AbortController();
      controller.current = ac;
      try {
        const reader = new NDEFReader();
        reader.onreading = (ev: NDEFReadingEvent) => {
          const uid = ev.serialNumber ? normalizeUid(ev.serialNumber) : null;
          let code: string | null = null;
          for (const record of ev.message?.records ?? []) {
            const text = decodeRecord(record);
            const parsed = text ? parseCardContent(text) : null;
            if (parsed) {
              code = parsed;
              break;
            }
          }
          const key = uid || code;
          if (!key) {
            onErrorRef.current('Carteirinha ilegível, tente de novo.');
            vibrate(VIBRATE.error);
            return;
          }
          const now = Date.now();
          if (lastRead.current && lastRead.current.key === key && now - lastRead.current.at < DUP_MS) return;
          lastRead.current = { key, at: now };
          onReadRef.current({ uid, code });
        };
        reader.onreadingerror = () => {
          onErrorRef.current('Carteirinha ilegível, tente de novo.');
          vibrate(VIBRATE.error);
        };
        await reader.scan({ signal: ac.signal });
        if (!ac.signal.aborted) setState('listening');
      } catch (err) {
        if (ac.signal.aborted) return;
        const name = err instanceof Error ? err.name : '';
        if (name === 'NotAllowedError') setState(userGesture ? 'blocked' : 'idle');
        else if (name === 'NotReadableError') setState('off');
        else if (name === 'NotSupportedError') setState('unsupported');
        else setState('idle');
      }
    },
    [supported]
  );

  const start = useCallback(() => startInternal(true), [startInternal]);

  useEffect(() => {
    if (!supported || !opts.enabled) {
      controller.current?.abort();
      controller.current = null;
      return;
    }
    let cancelled = false;
    const tryStart = () => {
      if (cancelled) return;
      void startInternal(false);
    };
    tryStart();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        controller.current?.abort();
        controller.current = null;
        setState((s) => (s === 'listening' || s === 'idle' ? 'paused' : s));
      } else {
        setState((s) => (s === 'paused' ? 'idle' : s));
        tryStart();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      controller.current?.abort();
      controller.current = null;
    };
  }, [supported, opts.enabled, startInternal]);

  return { state, start, stop, supported };
}
