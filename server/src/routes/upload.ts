/** Multipart helper: read one uploaded file field into a Buffer (≤ 2 MiB). */
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../lib/errors.js';
import { MAX_PHOTO_BYTES } from '../lib/photos.js';

export async function readUploadedFile(req: FastifyRequest, fieldName: string, maxBytes = MAX_PHOTO_BYTES): Promise<Buffer> {
  if (!req.isMultipart()) throw new ApiError('VALIDATION', `Envie o arquivo como multipart/form-data (campo "${fieldName}")`);
  let part: Awaited<ReturnType<FastifyRequest['file']>>;
  try {
    part = await req.file({ limits: { fileSize: maxBytes, files: 1 } });
  } catch (err) {
    throw mapMultipartError(err);
  }
  if (!part) throw new ApiError('VALIDATION', `Arquivo ausente (campo "${fieldName}")`);
  if (part.fieldname !== fieldName) throw new ApiError('VALIDATION', `Campo esperado: "${fieldName}"`);
  try {
    const buffer = await part.toBuffer();
    if (part.file.truncated || buffer.length > maxBytes) throw new ApiError('FILE_TOO_LARGE');
    return buffer;
  } catch (err) {
    throw mapMultipartError(err);
  }
}

export function mapMultipartError(err: unknown): unknown {
  if (err instanceof ApiError) return err;
  const e = err as { code?: string; statusCode?: number };
  if (e?.code === 'FST_REQ_FILE_TOO_LARGE' || e?.statusCode === 413) return new ApiError('FILE_TOO_LARGE');
  if (typeof e?.code === 'string' && e.code.startsWith('FST_')) return new ApiError('VALIDATION', 'Envio inválido');
  return err;
}
