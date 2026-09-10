/**
 * Photo storage. Files live in DATA_DIR/uploads/<fileId>.<ext>; the `files`
 * table keeps mime/size (detected by magic bytes, never client-supplied).
 * Photo URLs are signed: /api/files/<id>?t=<sig>, sig = base64url(HMAC-SHA256(files_secret, id)).slice(0, 32).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { type Db, one, run, tx } from '../db/index.js';
import type { FileRow } from '../db/rows.js';
import { ApiError } from './errors.js';
import { hmacSignature } from './crypto.js';

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export interface DetectedImage {
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  ext: 'jpg' | 'png' | 'webp';
}

/** Detect JPEG / PNG / WebP by their leading bytes. Anything else (SVG included) is rejected. */
export function detectImage(buf: Buffer): DetectedImage | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

export function uploadsDir(config: Config): string {
  return path.join(config.dataDir, 'uploads');
}

export function filePath(config: Config, row: Pick<FileRow, 'path'>): string {
  return path.join(uploadsDir(config), row.path);
}

export function fileSignature(filesSecret: string, fileId: string): string {
  return hmacSignature(filesSecret, fileId);
}

export function photoUrl(fileId: string | null | undefined, filesSecret: string): string | null {
  if (!fileId) return null;
  return `/api/files/${fileId}?t=${fileSignature(filesSecret, fileId)}`;
}

export function getFile(db: Db, id: string): FileRow | undefined {
  return one<FileRow>(db, 'SELECT * FROM files WHERE id = ?', id);
}

/** Delete the file row and the file on disk (ignores a missing file). */
export function deleteFile(db: Db, config: Config, fileId: string | null | undefined): void {
  if (!fileId) return;
  const row = getFile(db, fileId);
  if (!row) return;
  run(db, 'DELETE FROM files WHERE id = ?', fileId);
  try {
    fs.unlinkSync(filePath(config, row));
  } catch {
    // already gone
  }
}

export interface StorePhotoOptions {
  ownerTable: 'users' | 'children';
  ownerId: string;
  buffer: Buffer;
  actorId: string | null;
  now: Date;
}

/**
 * Validate, write to disk, insert the `files` row, point the owner at it and
 * delete the previous file. Returns the new file id.
 */
export function storePhoto(db: Db, config: Config, opts: StorePhotoOptions): string {
  if (opts.buffer.length === 0) throw new ApiError('VALIDATION', 'Arquivo vazio');
  if (opts.buffer.length > MAX_PHOTO_BYTES) throw new ApiError('FILE_TOO_LARGE');
  const detected = detectImage(opts.buffer);
  if (!detected) throw new ApiError('UNSUPPORTED_MEDIA');

  const owner = one<{ photo_file_id: string | null }>(db, `SELECT photo_file_id FROM ${opts.ownerTable} WHERE id = ?`, opts.ownerId);
  if (!owner) throw new ApiError('NOT_FOUND');

  const id = randomUUID();
  const relPath = `${id}.${detected.ext}`;
  const dir = uploadsDir(config);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, relPath), opts.buffer);

  try {
    tx(db, () => {
      run(
        db,
        'INSERT INTO files (id, mime, size, path, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        detected.mime,
        opts.buffer.length,
        relPath,
        opts.actorId,
        opts.now.toISOString()
      );
      run(db, `UPDATE ${opts.ownerTable} SET photo_file_id = ?, updated_at = ? WHERE id = ?`, id, opts.now.toISOString(), opts.ownerId);
      deleteFile(db, config, owner.photo_file_id);
    });
  } catch (e) {
    try {
      fs.unlinkSync(path.join(dir, relPath));
    } catch {
      // ignore
    }
    throw e;
  }
  return id;
}

/** Remove the owner's photo (used by anonymization). */
export function removePhoto(db: Db, config: Config, ownerTable: 'users' | 'children', ownerId: string, now: Date): void {
  const owner = one<{ photo_file_id: string | null }>(db, `SELECT photo_file_id FROM ${ownerTable} WHERE id = ?`, ownerId);
  if (!owner?.photo_file_id) return;
  run(db, `UPDATE ${ownerTable} SET photo_file_id = NULL, updated_at = ? WHERE id = ?`, now.toISOString(), ownerId);
  deleteFile(db, config, owner.photo_file_id);
}
