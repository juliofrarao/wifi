import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import jsQR from 'jsqr';

/**
 * QR scanner: rear camera via getUserMedia; BarcodeDetector when it supports
 * qr_code, else jsQR over a 640×480 canvas every ~120 ms. Auto-stops after
 * 30 s without a read. NotAllowedError → `denied` with guidance.
 */
export type QrState = 'idle' | 'starting' | 'scanning' | 'denied' | 'unavailable' | 'error';

export interface QrScanner {
  state: QrState;
  videoRef: RefObject<HTMLVideoElement | null>;
  start: () => Promise<void>;
  stop: () => void;
  /** Whether the scanner stopped because of the idle timeout. */
  timedOut: boolean;
  engine: 'native' | 'jsqr' | null;
}

const SCAN_INTERVAL_MS = 120;
const IDLE_TIMEOUT_MS = 30_000;
const DUP_MS = 2000;

async function nativeDetector(): Promise<BarcodeDetector | null> {
  try {
    if (typeof BarcodeDetector === 'undefined') return null;
    const formats = await BarcodeDetector.getSupportedFormats();
    if (!formats.includes('qr_code')) return null;
    return new BarcodeDetector({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

export function useQrScanner(opts: { onCode: (raw: string) => void; idleTimeoutMs?: number }): QrScanner {
  const [state, setState] = useState<QrState>('idle');
  const [timedOut, setTimedOut] = useState(false);
  const [engine, setEngine] = useState<'native' | 'jsqr' | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef(false);
  const startSeq = useRef(0);
  const lastCode = useRef<{ value: string; at: number } | null>(null);
  const onCodeRef = useRef(opts.onCode);
  onCodeRef.current = opts.onCode;
  const idleMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;

  const stop = useCallback(() => {
    startSeq.current++;
    running.current = false;
    if (timer.current) clearTimeout(timer.current);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    timer.current = null;
    idleTimer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState((s) => (s === 'denied' || s === 'unavailable' || s === 'error' ? s : 'idle'));
  }, []);

  const armIdle = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      setTimedOut(true);
      stop();
    }, idleMs);
  }, [idleMs, stop]);

  const start = useCallback(async () => {
    stop();
    const seq = ++startSeq.current;
    setTimedOut(false);
    setState('starting');
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('unavailable');
      return;
    }
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      if (seq !== startSeq.current) return;
      const name = err instanceof Error ? err.name : '';
      setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'unavailable' : 'error');
      return;
    }
    if (seq !== startSeq.current) {
      media.getTracks().forEach((t) => t.stop()); // a newer start()/stop() won
      return;
    }
    stream.current = media;
    const video = videoRef.current;
    if (!video) {
      media.getTracks().forEach((t) => t.stop());
      setState('error');
      return;
    }
    video.srcObject = media;
    video.setAttribute('playsinline', 'true');
    video.muted = true;
    try {
      await video.play();
    } catch {
      /* autoplay policies: the video still receives frames */
    }
    const detector = await nativeDetector();
    if (seq !== startSeq.current) return;
    setEngine(detector ? 'native' : 'jsqr');
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    running.current = true;
    setState('scanning');
    armIdle();

    const emit = (value: string) => {
      const now = Date.now();
      if (lastCode.current && lastCode.current.value === value && now - lastCode.current.at < DUP_MS) return;
      lastCode.current = { value, at: now };
      armIdle();
      onCodeRef.current(value);
    };

    const tick = async () => {
      if (!running.current) return;
      try {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          if (detector) {
            const codes = await detector.detect(video);
            const hit = codes.find((c) => c.rawValue);
            if (hit) emit(hit.rawValue);
          } else if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const result = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (result?.data) emit(result.data);
          }
        }
      } catch {
        /* a frame failed to decode; keep going */
      }
      if (running.current) timer.current = setTimeout(() => void tick(), SCAN_INTERVAL_MS);
    };
    void tick();
  }, [armIdle, stop]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [stop]);

  return { state, videoRef, start, stop, timedOut, engine };
}
