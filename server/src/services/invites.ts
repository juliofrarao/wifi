/**
 * Invite / reset tokens (spec §4.6): 32 random bytes, SHA-256 stored, invite
 * valid 90 days, reset 1 h; issuing a new one invalidates the previous of the
 * same kind. `issueInvite` also builds the InviteResult (e-mail, WhatsApp, QR).
 */
import { randomUUID } from 'node:crypto';
import { type InviteResult, formatDateTime, whatsappDigits } from '@creche/shared';
import type { Ctx } from '../context.js';
import { type Db, one, run } from '../db/index.js';
import { getSetting, SETTING_KEYS } from '../db/settings.js';
import type { AuthTokenRow, UserRow } from '../db/rows.js';
import { ApiError } from '../lib/errors.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { DAY_MS, HOUR_MS } from '../lib/time.js';
import { inviteEmail, resetEmail } from './email.js';

export type TokenKind = 'invite' | 'reset';

export const TOKEN_TTL_MS: Record<TokenKind, number> = { invite: 90 * DAY_MS, reset: HOUR_MS };

export interface CreatedToken {
  token: string;
  expiresAt: string;
}

export function createAuthToken(db: Db, userId: string, kind: TokenKind, now: Date): CreatedToken {
  run(db, 'DELETE FROM auth_tokens WHERE user_id = ? AND kind = ? AND used_at IS NULL', userId, kind);
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS[kind]).toISOString();
  run(
    db,
    'INSERT INTO auth_tokens (id, user_id, kind, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
    randomUUID(),
    userId,
    kind,
    sha256Hex(token),
    expiresAt,
    now.toISOString()
  );
  return { token, expiresAt };
}

/** Resolve a raw token; throws INVALID_TOKEN / TOKEN_EXPIRED. */
export function resolveAuthToken(db: Db, kind: TokenKind, token: string, now: Date): { row: AuthTokenRow; user: UserRow } {
  if (!token || token.length < 20 || token.length > 200) throw new ApiError('INVALID_TOKEN');
  const row = one<AuthTokenRow>(db, 'SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = ?', sha256Hex(token), kind);
  if (!row || row.used_at) throw new ApiError('INVALID_TOKEN');
  if (new Date(row.expires_at).getTime() <= now.getTime()) throw new ApiError('TOKEN_EXPIRED');
  const user = one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', row.user_id);
  if (!user || !user.active || user.anonymized_at) throw new ApiError('INVALID_TOKEN');
  return { row, user };
}

export function markTokenUsed(db: Db, tokenId: string, now: Date): void {
  run(db, 'UPDATE auth_tokens SET used_at = ? WHERE id = ?', now.toISOString(), tokenId);
}

export function tokenUrl(appUrl: string, kind: TokenKind, token: string): string {
  return `${appUrl}/${kind === 'invite' ? 'convite' : 'redefinir'}/${token}`;
}

export function whatsappMessage(kind: TokenKind, daycareName: string, name: string, url: string, expiresAt: string, tz: string): string {
  const first = name.split(/\s+/)[0];
  const until = formatDateTime(expiresAt, tz);
  if (kind === 'invite') {
    return `Olá, ${first}! A ${daycareName} usa o Creche Segura para registrar a entrada e a saída das crianças e avisar os responsáveis na hora. Crie sua senha pelo link (válido até ${until}): ${url}`;
  }
  return `Olá, ${first}! Aqui está o link para definir uma nova senha no Creche Segura da ${daycareName} (válido até ${until}): ${url}`;
}

export interface IssueOptions {
  kind: TokenKind;
  /** Try to send the e-mail (when the mailer is enabled and the user has an e-mail). */
  send: boolean;
}

/**
 * Create the token and build the InviteResult. Sends the e-mail when
 * requested/possible; a failed send is recorded in users.last_email_error and
 * yields `sent: false` (the admin still gets the link).
 */
export async function issueInvite(ctx: Ctx, user: UserRow, opts: IssueOptions): Promise<InviteResult> {
  const now = ctx.now();
  const { token, expiresAt } = createAuthToken(ctx.db, user.id, opts.kind, now);
  const daycareName = getSetting(ctx.db, SETTING_KEYS.daycareName) ?? ctx.config.daycareName;
  const url = tokenUrl(ctx.config.appUrl, opts.kind, token);
  let sent = false;
  if (opts.send && ctx.mailer.enabled && user.email) {
    const mail = (opts.kind === 'invite' ? inviteEmail : resetEmail)({ daycareName, name: user.name, url, expiresAt, tz: ctx.config.tz });
    try {
      await ctx.mailer.send({ to: user.email, replyTo: getSetting(ctx.db, SETTING_KEYS.contactEmail), ...mail });
      sent = true;
      run(ctx.db, 'UPDATE users SET last_email_error = NULL WHERE id = ?', user.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warn({ err, userId: user.id }, 'falha ao enviar e-mail de convite');
      run(ctx.db, 'UPDATE users SET last_email_error = ? WHERE id = ?', `${now.toISOString()} ${message}`.slice(0, 300), user.id);
    }
  }
  const digits = whatsappDigits(user.phone);
  const whatsappUrl = digits ? `https://wa.me/${digits}?text=${encodeURIComponent(whatsappMessage(opts.kind, daycareName, user.name, url, expiresAt, ctx.config.tz))}` : null;
  return { sent, inviteUrl: url, whatsappUrl, expiresAt, kind: opts.kind };
}
