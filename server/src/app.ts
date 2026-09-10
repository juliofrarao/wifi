/**
 * Fastify application factory. `buildApp(deps)` wires plugins, the error
 * handler, every /api route module, the static web bundle and the SPA fallback.
 * It never listens — index.ts (and tests, through app.inject) do that.
 */
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { registerAuth } from './auth/plugin.js';
import { registerAuthRoutes } from './auth/routes.js';
import { filesSecretOf, seedSettings } from './bootstrap.js';
import type { AppDeps, Ctx } from './context.js';
import { ApiError, isApiError } from './lib/errors.js';
import { MAX_PHOTO_BYTES } from './lib/photos.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAttendanceRoutes } from './routes/attendance.js';
import { registerChildRoutes } from './routes/children.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerCredentialRoutes } from './routes/credentials.js';
import { registerFileRoutes } from './routes/files.js';
import { registerMeRoutes } from './routes/me.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerScanRoutes } from './routes/scan.js';
import { registerUserRoutes } from './routes/users.js';

export type { AppDeps, Ctx } from './context.js';

const NO_CACHE_FILES = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'version.json']);

/**
 * CSP for the PWA (spec §8: no inline scripts). `style-src 'unsafe-inline'` is needed for React
 * style attributes and the noscript message; images may be data:/blob: (QR codes, photo previews).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** `TRUST_PROXY=1` trusts only the nearest proxy hop, `2` the two nearest, etc. */
function hopCountTrust(hops: number): (address: string, hop: number) => boolean {
  return (_address, hop) => hop < hops;
}

/** Invite/reset tokens and photo signatures travel in URLs: never write them to logs (SEC-5). */
export function redactUrl(url: string): string {
  return url.replace(/(\/api\/auth\/(?:invite|reset)\/)[^/?#]+/, '$1<redacted>').replace(/([?&]t=)[^&#]+/, '$1<redacted>');
}

export function readWebVersion(webDist: string): string {
  try {
    const raw = fs.readFileSync(path.join(webDist, 'version.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) return parsed.version.trim();
  } catch {
    // no bundle / no version file
  }
  return 'dev';
}

export interface BuildOptions {
  /** Fastify logger option (default: config.logLevel). Tests pass `false`. */
  logger?: boolean | { level: string };
}

/** Map any thrown error to the API error body. */
export function toApiError(err: unknown): ApiError {
  if (isApiError(err)) return err as ApiError;
  const e = err as Partial<FastifyError> & { validation?: unknown; code?: string; statusCode?: number };
  if (e?.code === 'FST_REQ_FILE_TOO_LARGE' || e?.statusCode === 413) return new ApiError('FILE_TOO_LARGE');
  if (e?.statusCode === 415) return new ApiError('UNSUPPORTED_MEDIA');
  if (e?.statusCode === 400 || e?.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || e?.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
    return new ApiError('VALIDATION', e.message && /JSON/i.test(e.message) ? 'Corpo da requisição inválido (JSON)' : (e.message ?? 'Dados inválidos'));
  }
  if (e?.statusCode === 401) return new ApiError('UNAUTHORIZED');
  if (e?.statusCode === 403) return new ApiError('FORBIDDEN');
  if (e?.statusCode === 404) return new ApiError('NOT_FOUND');
  if (e?.statusCode === 429) return new ApiError('RATE_LIMITED', undefined, { retryAfterSeconds: 60 });
  return new ApiError('INTERNAL');
}

export function buildApp(deps: AppDeps, options: BuildOptions = {}): FastifyInstance {
  const { db, config } = deps;
  seedSettings(db, config);

  const app = Fastify({
    logger: options.logger ?? {
      level: config.logLevel,
      serializers: {
        req: (req: { method: string; url: string; ip?: string }) => ({ method: req.method, url: redactUrl(req.url), remoteAddress: req.ip }),
      },
    },
    // Fastify's types do not admit a hop count; express it as the equivalent function.
    trustProxy: typeof config.trustProxy === 'number' ? hopCountTrust(config.trustProxy) : config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  // Browser hardening on every response (photos keep their own sandbox CSP, see routes/files.ts).
  app.addHook('onSend', async (req, reply) => {
    if (!req.url.startsWith('/api/files/')) reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'geolocation=(), payment=()');
    if (config.trustProxy) reply.header('Strict-Transport-Security', 'max-age=31536000');
  });

  const ctx: Ctx = {
    ...deps,
    now: deps.now ?? (() => new Date()),
    filesSecret: filesSecretOf(db),
    log: app.log,
    appVersion: readWebVersion(config.webDist),
  };

  app.register(multipart, { limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 20 }, throwFileSizeLimit: true });

  // Error handler: ApiError → HTTP + JSON; zod already becomes ApiError in lib/validate.
  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    const apiErr = toApiError(err);
    if (apiErr.code === 'INTERNAL') req.log.error({ err }, 'erro interno');
    else req.log.debug({ code: apiErr.code, url: redactUrl(req.url) }, apiErr.message);
    if (apiErr.code === 'RATE_LIMITED') {
      const retry = (apiErr.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      if (retry) reply.header('Retry-After', String(retry));
    }
    reply.code(apiErr.status).send(apiErr.toBody());
  });

  const webDistExists = fs.existsSync(path.join(config.webDist, 'index.html'));

  // 404: JSON under /api, SPA fallback elsewhere.
  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url === '/api' || req.url.startsWith('/api/');
    if (isApi || (req.method !== 'GET' && req.method !== 'HEAD')) {
      reply.code(404).send(new ApiError('NOT_FOUND', 'Rota não encontrada').toBody());
      return;
    }
    if (!webDistExists) {
      reply.code(404).type('text/plain; charset=utf-8').send('App web não compilado (WEB_DIST). Em desenvolvimento use o Vite.');
      return;
    }
    reply.header('Cache-Control', 'no-cache');
    reply.sendFile('index.html', config.webDist, { cacheControl: false });
  });

  // API
  app.register(
    async (api) => {
      registerAuth(api, ctx);
      registerConfigRoutes(api, ctx);
      registerPublicRoutes(api, ctx);
      registerFileRoutes(api, ctx);
      registerAuthRoutes(api, ctx);
      registerMeRoutes(api, ctx);
      registerUserRoutes(api, ctx);
      registerChildRoutes(api, ctx);
      registerCredentialRoutes(api, ctx);
      registerAdminRoutes(api, ctx);
      registerScanRoutes(api, ctx);
      registerAttendanceRoutes(api, ctx);
      registerReportRoutes(api, ctx);
      registerNotificationRoutes(api, ctx);
    },
    { prefix: '/api' }
  );

  // Static web bundle (production). Vite serves the app in development.
  if (webDistExists) {
    app.register(fastifyStatic, {
      root: config.webDist,
      prefix: '/',
      wildcard: true,
      index: false,
      decorateReply: true,
      cacheControl: true,
      maxAge: 0,
      setHeaders(reply, filePath) {
        const rel = path.relative(config.webDist, filePath).split(path.sep).join('/');
        if (rel.startsWith('assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        else if (NO_CACHE_FILES.has(rel)) reply.header('Cache-Control', 'no-cache');
      },
    });
    app.get('/', (_req, reply) => {
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html', config.webDist, { cacheControl: false });
    });
  }

  return app;
}
