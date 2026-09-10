import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** Renders `value` as a QR code PNG data URL (quiet zone included). */
export function QrCodeImage({ value, size = 200, alt, className = '' }: { value: string; size?: number; alt?: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { width: size, margin: 2, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);
  if (!src) return <span className={`avatar avatar--square ${className}`.trim()} aria-hidden="true" />;
  return <img src={src} width={size} height={size} alt={alt ?? `QR Code: ${value}`} className={className} />;
}
