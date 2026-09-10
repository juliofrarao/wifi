/// <reference types="vite/client" />

/** Build identifier injected by vite.config.ts (short git sha + build time, or "dev"). */
declare const __APP_VERSION__: string;

// Web NFC (Chrome/Android) — minimal typings.
interface NDEFRecord {
  recordType: string;
  mediaType?: string;
  id?: string;
  data?: DataView;
  encoding?: string;
  lang?: string;
}
interface NDEFMessage {
  records: ReadonlyArray<NDEFRecord>;
}
interface NDEFReadingEvent extends Event {
  serialNumber: string;
  message: NDEFMessage;
}
interface NDEFScanOptions {
  signal?: AbortSignal;
}
declare class NDEFReader extends EventTarget {
  constructor();
  scan(options?: NDEFScanOptions): Promise<void>;
  write(message: unknown, options?: { overwrite?: boolean; signal?: AbortSignal }): Promise<void>;
  makeReadOnly(options?: { signal?: AbortSignal }): Promise<void>;
  onreading: ((this: NDEFReader, event: NDEFReadingEvent) => void) | null;
  onreadingerror: ((this: NDEFReader, event: Event) => void) | null;
}

// Barcode Detection API — minimal typings.
interface DetectedBarcode {
  rawValue: string;
  format: string;
}
declare class BarcodeDetector {
  constructor(options?: { formats: string[] });
  static getSupportedFormats(): Promise<string[]>;
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
}

interface Navigator {
  standalone?: boolean;
}
