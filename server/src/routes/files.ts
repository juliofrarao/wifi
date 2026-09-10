/** GET /api/files/:id?t=<sig> — signed photo URLs, no session (spec §8). */
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { constantTimeEqual } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { fileSignature, filePath, getFile } from '../lib/photos.js';

export function registerFileRoutes(api: FastifyInstance, ctx: Ctx): void {
  api.get<{ Params: { id: string }; Querystring: { t?: string } }>('/files/:id', async (req, reply) => {
    const { id } = req.params;
    const sig = typeof req.query.t === 'string' ? req.query.t : '';
    if (!/^[0-9a-f-]{36}$/i.test(id) || !sig) throw new ApiError('NOT_FOUND');
    const expected = fileSignature(ctx.filesSecret, id);
    if (!constantTimeEqual(sig, expected)) throw new ApiError('NOT_FOUND');
    const row = getFile(ctx.db, id);
    if (!row) throw new ApiError('NOT_FOUND');
    const abs = filePath(ctx.config, row);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new ApiError('NOT_FOUND');
    }
    const etag = `"${row.id}-${stat.size}"`;
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.header('ETag', etag);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Disposition', 'inline');
    reply.header('Content-Security-Policy', 'sandbox');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    reply.type(row.mime);
    reply.header('Content-Length', stat.size);
    return reply.send(fs.createReadStream(abs));
  });
}
