/**
 * Resizes a photo in the browser to ≤ `maxSize` px (longest side) and encodes
 * it as JPEG (quality 0.85). Re-encoding also strips EXIF metadata.
 * Returns the original Blob when it cannot be decoded (the server validates bytes).
 */
export async function resizePhoto(file: Blob, maxSize = 512, quality = 0.85): Promise<Blob> {
  let bitmap: ImageBitmap | HTMLImageElement;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    try {
      bitmap = await loadImage(file);
    } catch {
      return file;
    }
  }
  const w = 'naturalWidth' in bitmap ? bitmap.naturalWidth : bitmap.width;
  const h = 'naturalHeight' in bitmap ? bitmap.naturalHeight : bitmap.height;
  if (!w || !h) return file;
  const scale = Math.min(1, maxSize / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, tw, th);
  if ('close' in bitmap) bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  return blob ?? file;
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Imagem inválida'));
    };
    img.src = url;
  });
}

/** Builds the multipart body expected by the photo upload routes (field "photo"). */
export function photoFormData(blob: Blob, filename = 'foto.jpg'): FormData {
  const fd = new FormData();
  fd.append('photo', blob, filename);
  return fd;
}
