import { useId, useRef, useState } from 'react';
import { describeError } from '../api/client';
import { photoFormData, resizePhoto } from '../lib/photo';
import { Avatar } from './Avatar';
import { Banner } from './Banner';
import { Button } from './Button';
import { useToast } from './Toast';

/**
 * Photo picker (camera or gallery) → resize to ≤ 512 px JPEG → upload.
 * `upload` receives the multipart FormData and returns the new URL.
 */
export function PhotoUpload({
  name,
  photoUrl,
  upload,
  onUploaded,
  square = false,
  hint = 'A foto é conferida pela portaria. Use um rosto bem visível, de frente.',
}: {
  name: string;
  photoUrl: string | null;
  upload: (form: FormData) => Promise<{ photoUrl: string }>;
  onUploaded: (url: string) => void;
  square?: boolean;
  hint?: string;
}) {
  const toast = useToast();
  const id = useId();
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const handle = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await resizePhoto(file);
      const url = URL.createObjectURL(blob);
      setPreview(url);
      const result = await upload(photoFormData(blob));
      onUploaded(result.photoUrl);
      toast.show('Foto atualizada.', 'success');
    } catch (err) {
      setError(describeError(err));
      setPreview(null);
    } finally {
      setBusy(false);
      if (cameraRef.current) cameraRef.current.value = '';
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <Avatar name={name} photoUrl={preview ?? photoUrl} size="xl" square={square} noPhotoBadge />
        <div className="stack stack--sm grow">
          <input
            ref={cameraRef}
            id={`${id}-camera`}
            className="visually-hidden"
            type="file"
            accept="image/*"
            capture="user"
            onChange={(e) => void handle(e.target.files?.[0])}
            disabled={busy}
          />
          <input ref={fileRef} id={`${id}-file`} className="visually-hidden" type="file" accept="image/*" onChange={(e) => void handle(e.target.files?.[0])} disabled={busy} />
          <Button variant="primary" icon="📷" loading={busy} onClick={() => cameraRef.current?.click()}>
            Tirar foto
          </Button>
          <Button variant="neutral" icon="🖼️" disabled={busy} onClick={() => fileRef.current?.click()}>
            Escolher arquivo
          </Button>
          <p className="tiny muted">{hint} Máximo 2 MB (JPEG, PNG ou WebP); a imagem é reduzida antes do envio.</p>
        </div>
      </div>
      {error ? <Banner kind="danger">{error}</Banner> : null}
    </div>
  );
}
