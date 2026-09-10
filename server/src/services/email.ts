/**
 * E-mail (nodemailer). `createMailer(config)` returns a disabled mailer when
 * SMTP_HOST is empty. Tests inject `createFakeMailer()` (records to `outbox`).
 * Message texts (pt-BR) for invites/resets/tests live here.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { formatDateTime } from '@creche/shared';
import type { Config } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string | null;
}

export interface Mailer {
  readonly enabled: boolean;
  /** Resolves when accepted by the SMTP server; rejects on failure. */
  send(message: MailMessage): Promise<void>;
}

export interface FakeMailer extends Mailer {
  outbox: MailMessage[];
  /** When set, `send` rejects with this error (to simulate SMTP failures). */
  failWith: Error | null;
}

export function createMailer(config: Config): Mailer {
  const { smtp } = config;
  if (!smtp.host) {
    return {
      enabled: false,
      async send() {
        throw new Error('E-mail não configurado (SMTP_HOST vazio)');
      },
    };
  }
  const transport: Transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? '' } : undefined,
    connectionTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    enabled: true,
    async send(message) {
      await transport.sendMail({
        from: smtp.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo: message.replyTo ?? undefined,
      });
    },
  };
}

export function createFakeMailer(enabled = true): FakeMailer {
  const outbox: MailMessage[] = [];
  const fake: FakeMailer = {
    enabled,
    outbox,
    failWith: null,
    async send(message) {
      if (!fake.enabled) throw new Error('E-mail não configurado');
      if (fake.failWith) throw fake.failWith;
      outbox.push(message);
    },
  };
  return fake;
}

/**
 * Classify an SMTP error: 4xx responses are transient (retry), 5xx and
 * everything else are permanent. Used by S2's dispatcher.
 */
export function isTransientMailError(err: unknown): boolean {
  const e = err as { responseCode?: number; code?: string } | null;
  if (!e) return false;
  if (typeof e.responseCode === 'number') return e.responseCode >= 400 && e.responseCode < 500;
  return e.code === 'ETIMEDOUT' || e.code === 'ECONNECTION' || e.code === 'ECONNRESET' || e.code === 'ESOCKET';
}

// ---------------------------------------------------------------------------
// Templates (pt-BR)
// ---------------------------------------------------------------------------

export function subjectPrefix(daycareName: string): string {
  return `[${daycareName}]`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Minimal HTML wrapper shared by all e-mails. */
export function htmlLayout(daycareName: string, paragraphs: string[], cta?: { label: string; url: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:16px;line-height:1.5">${p}</p>`).join('');
  const button = cta
    ? `<p style="margin:20px 0"><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:12px 20px;background:#1a7f4b;color:#fff;text-decoration:none;border-radius:6px;font-size:16px">${escapeHtml(cta.label)}</a></p><p style="font-size:13px;color:#555">Se o botão não funcionar, copie este endereço: ${escapeHtml(cta.url)}</p>`
    : '';
  return `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#222;background:#f6f6f6;margin:0;padding:24px"><div style="max-width:560px;margin:0 auto;background:#fff;padding:24px;border-radius:8px"><h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(daycareName)}</h1>${body}${button}<hr style="border:none;border-top:1px solid #ddd;margin:24px 0"><p style="font-size:12px;color:#777">Mensagem automática do Creche Segura. Não responda este e-mail; em caso de dúvida, fale com a secretaria.</p></div></body></html>`;
}

export interface TokenMailInput {
  daycareName: string;
  name: string;
  url: string;
  expiresAt: string;
  tz: string;
}

export function inviteEmail(i: TokenMailInput): Pick<MailMessage, 'subject' | 'text' | 'html'> {
  const until = formatDateTime(i.expiresAt, i.tz);
  const first = i.name.split(/\s+/)[0];
  return {
    subject: `${subjectPrefix(i.daycareName)} Seu acesso ao Creche Segura`,
    text: `Olá, ${first}!\n\nA ${i.daycareName} usa o Creche Segura para registrar a entrada e a saída das crianças e avisar os responsáveis na hora.\n\nCrie sua senha pelo link abaixo (válido até ${until}):\n${i.url}\n\nDepois, adicione o app à tela inicial do celular e ative as notificações para receber os alertas.\n\nSe você não esperava este e-mail, ignore-o.`,
    html: htmlLayout(
      i.daycareName,
      [
        `Olá, <strong>${escapeHtml(first)}</strong>!`,
        `A ${escapeHtml(i.daycareName)} usa o Creche Segura para registrar a entrada e a saída das crianças e avisar os responsáveis na hora.`,
        `Crie sua senha pelo botão abaixo (válido até ${escapeHtml(until)}). Depois, adicione o app à tela inicial do celular e ative as notificações.`,
      ],
      { label: 'Criar minha senha', url: i.url }
    ),
  };
}

export function resetEmail(i: TokenMailInput): Pick<MailMessage, 'subject' | 'text' | 'html'> {
  const until = formatDateTime(i.expiresAt, i.tz);
  const first = i.name.split(/\s+/)[0];
  return {
    subject: `${subjectPrefix(i.daycareName)} Redefinição de senha`,
    text: `Olá, ${first}!\n\nRecebemos um pedido para redefinir a sua senha no Creche Segura da ${i.daycareName}.\n\nDefina uma nova senha pelo link abaixo (válido até ${until}):\n${i.url}\n\nSe você não pediu a redefinição, ignore este e-mail — sua senha continua a mesma.`,
    html: htmlLayout(
      i.daycareName,
      [
        `Olá, <strong>${escapeHtml(first)}</strong>!`,
        `Recebemos um pedido para redefinir a sua senha no Creche Segura da ${escapeHtml(i.daycareName)}.`,
        `Defina uma nova senha pelo botão abaixo (válido até ${escapeHtml(until)}). Se você não pediu a redefinição, ignore este e-mail.`,
      ],
      { label: 'Definir nova senha', url: i.url }
    ),
  };
}

export function testEmail(daycareName: string, now: Date, tz: string): Pick<MailMessage, 'subject' | 'text' | 'html'> {
  const when = formatDateTime(now, tz);
  return {
    subject: `${subjectPrefix(daycareName)} Teste de e-mail`,
    text: `Este é um e-mail de teste do Creche Segura enviado em ${when}. Se você o recebeu, o envio de e-mails está funcionando.`,
    html: htmlLayout(daycareName, [`Este é um e-mail de teste do Creche Segura enviado em ${escapeHtml(when)}.`, 'Se você o recebeu, o envio de e-mails está funcionando.']),
  };
}
