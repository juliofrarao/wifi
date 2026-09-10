/**
 * ApiError — the only error shape routes should throw. The global error
 * handler (app.ts) maps it to `{ error: { code, message, details } }` with the
 * HTTP status from ERROR_HTTP_STATUS.
 */
import { ERROR_HTTP_STATUS, type ErrorCode } from '@creche/shared';

/** Default user-facing messages (pt-BR) per code. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION: 'Dados inválidos',
  INVALID_TOKEN: 'Link inválido',
  TOKEN_EXPIRED: 'Este link expirou',
  OCCURRED_AT_INVALID: 'Horário inválido',
  WEAK_PASSWORD: 'Senha muito fraca',
  UNAUTHORIZED: 'Entre novamente para continuar',
  INVALID_CREDENTIALS: 'E-mail/login ou senha incorretos',
  INVALID_PIN: 'PIN incorreto',
  FORBIDDEN: 'Você não tem permissão para esta ação',
  PICKUP_NOT_ALLOWED: 'Pessoa não autorizada a retirar a criança',
  GUARDIAN_BLOCKED: 'Responsável bloqueado — chame a direção',
  NOT_FOUND: 'Não encontrado',
  CARD_NOT_FOUND: 'Carteirinha não reconhecida',
  CARD_REVOKED: 'Carteirinha cancelada — avise a direção',
  OWNER_INACTIVE: 'Cadastro inativo — avise a direção',
  INVALID_STATE: 'Operação não permitida no estado atual',
  STALE_PRESENCE: 'Saída de um dia anterior não registrada — informe uma observação',
  EMAIL_IN_USE: 'Já existe um cadastro com este e-mail',
  LOGIN_IN_USE: 'Já existe um cadastro com este login',
  CREDENTIAL_MISMATCH: 'Carteirinha inconsistente — avise a direção',
  CODE_IN_USE: 'Código já em uso',
  UID_IN_USE: 'Esta etiqueta NFC já está vinculada a outra carteirinha',
  QUEUE_PENDING: 'Há registros aguardando envio',
  FILE_TOO_LARGE: 'Arquivo muito grande (máximo 2 MB)',
  UNSUPPORTED_MEDIA: 'Formato de arquivo não suportado (use JPEG, PNG ou WebP)',
  RATE_LIMITED: 'Muitas tentativas — aguarde e tente de novo',
  EMAIL_DISABLED: 'Envio de e-mail não configurado',
  INTERNAL: 'Erro interno no servidor',
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_HTTP_STATUS[this.code];
  }

  toBody(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    return {
      error: this.details === undefined ? { code: this.code, message: this.message } : { code: this.code, message: this.message, details: this.details },
    };
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ApiError');
}

export const notFound = (message?: string) => new ApiError('NOT_FOUND', message);
export const forbidden = (message?: string) => new ApiError('FORBIDDEN', message);
export const unauthorized = (message?: string) => new ApiError('UNAUTHORIZED', message);
export const invalidState = (message?: string) => new ApiError('INVALID_STATE', message);
export const validation = (message: string, path = '') =>
  new ApiError('VALIDATION', message, { issues: [{ path, message }] });
export const rateLimited = (retryAfterSeconds: number) =>
  new ApiError('RATE_LIMITED', ERROR_MESSAGES.RATE_LIMITED, { retryAfterSeconds });
