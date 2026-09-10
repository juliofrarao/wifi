/**
 * BroadcastChannel "creche-gate": lets /c/:code (opened from a QR in another
 * tab) hand a code to an open gate session.
 *
 * Messages:
 *  - { type: 'ping' }              → "is there a gate reader open?"
 *  - { type: 'pong' }              → answered by the gate reader
 *  - { type: 'code', code }        → a card code to resolve on the gate
 */
export const GATE_CHANNEL = 'creche-gate';

export type GateMessage = { type: 'ping' } | { type: 'pong' } | { type: 'code'; code: string };

export interface GateChannel {
  post(msg: GateMessage): void;
  subscribe(fn: (msg: GateMessage) => void): () => void;
  close(): void;
}

export function openGateChannel(): GateChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const ch = new BroadcastChannel(GATE_CHANNEL);
  const listeners = new Set<(msg: GateMessage) => void>();
  ch.onmessage = (ev: MessageEvent<GateMessage>) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    for (const l of [...listeners]) l(msg);
  };
  return {
    post(msg) {
      try {
        ch.postMessage(msg);
      } catch {
        /* closed */
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    close() {
      listeners.clear();
      ch.close();
    },
  };
}

/** Asks whether a gate reader is open in another tab (resolves within `timeoutMs`). */
export function pingGate(timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const ch = openGateChannel();
    if (!ch) {
      resolve(false);
      return;
    }
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      ch.close();
      resolve(v);
    };
    ch.subscribe((msg) => {
      if (msg.type === 'pong') finish(true);
    });
    ch.post({ type: 'ping' });
    setTimeout(() => finish(false), timeoutMs);
  });
}

/** Sends a code to the gate reader in another tab. */
export function sendCodeToGate(code: string): void {
  const ch = openGateChannel();
  if (!ch) return;
  ch.post({ type: 'code', code });
  setTimeout(() => ch.close(), 100);
}
