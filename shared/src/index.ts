/**
 * Creche Segura — shared API contract (v2).
 *
 * Everything the server exposes and the web app consumes is typed here.
 * Request bodies are validated with the zod schemas; responses use the DTO
 * interfaces. Keep this file free of Node/browser-only APIs.
 *
 * Conventions:
 *  - all ids are UUID v4;
 *  - instants are ISO 8601 UTC with milliseconds and a `Z` suffix
 *    (`Date.prototype.toISOString()`), e.g. occurredAt, createdAt;
 *  - civil dates are `YYYY-MM-DD` in the daycare time zone, e.g. birthDate,
 *    validUntil, report dates;
 *  - card codes travel NORMALIZED (8 uppercase chars, no dash) and NFC uids
 *    travel NORMALIZED (lowercase hex, no separators). Only the UI formats.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const ROLES = ['admin', 'guard', 'guardian'] as const;
export type Role = (typeof ROLES)[number];

export const EVENT_TYPES = ['checkin', 'checkout', 'denied'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const METHODS = ['nfc', 'qr', 'code', 'search', 'manual', 'auto'] as const;
export type Method = (typeof METHODS)[number];

export const OWNER_TYPES = ['guardian', 'child'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

export const SHIFTS = ['manha', 'tarde', 'integral'] as const;
export type Shift = (typeof SHIFTS)[number];

export const RELATIONSHIPS = [
  'mae',
  'pai',
  'avo',
  'avoh',
  'tio',
  'tia',
  'irmao',
  'irma',
  'padrasto',
  'madrasta',
  'responsavel_legal',
  'outro',
] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

/** Relationships that may sign the LGPD consent (art. 14). */
export const CONSENT_RELATIONSHIPS = ['mae', 'pai', 'responsavel_legal'] as const;

export const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  mae: 'Mãe',
  pai: 'Pai',
  avo: 'Avó',
  avoh: 'Avô',
  tio: 'Tio',
  tia: 'Tia',
  irmao: 'Irmão',
  irma: 'Irmã',
  padrasto: 'Padrasto',
  madrasta: 'Madrasta',
  responsavel_legal: 'Responsável legal',
  outro: 'Outro',
};

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administração',
  guard: 'Portaria',
  guardian: 'Responsável',
};

export const METHOD_LABELS: Record<Method, string> = {
  nfc: 'NFC',
  qr: 'QR Code',
  code: 'Código digitado',
  search: 'Busca por nome',
  manual: 'Manual',
  auto: 'Automático',
};

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  checkin: 'Entrada',
  checkout: 'Saída',
  denied: 'Recusa',
};

export const SHIFT_LABELS: Record<Shift, string> = {
  manha: 'Manhã',
  tarde: 'Tarde',
  integral: 'Integral',
};

export const NOTIFICATION_CHANNELS = ['inapp', 'push', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const NOTIFICATION_KINDS = [
  'checkin',
  'checkout',
  'denied',
  'void',
  'guardian_added',
  'authorization_added',
  'credential_revoked',
  'system',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  'VALIDATION',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'OCCURRED_AT_INVALID',
  'WEAK_PASSWORD',
  'UNAUTHORIZED',
  'INVALID_CREDENTIALS',
  'INVALID_PIN',
  'FORBIDDEN',
  'PICKUP_NOT_ALLOWED',
  'GUARDIAN_BLOCKED',
  'NOT_FOUND',
  'CARD_NOT_FOUND',
  'CARD_REVOKED',
  'OWNER_INACTIVE',
  'INVALID_STATE',
  'STALE_PRESENCE',
  'EMAIL_IN_USE',
  'LOGIN_IN_USE',
  'CREDENTIAL_MISMATCH',
  'CODE_IN_USE',
  'UID_IN_USE',
  'QUEUE_PENDING',
  'FILE_TOO_LARGE',
  'UNSUPPORTED_MEDIA',
  'RATE_LIMITED',
  'EMAIL_DISABLED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  INVALID_TOKEN: 400,
  TOKEN_EXPIRED: 400,
  OCCURRED_AT_INVALID: 400,
  WEAK_PASSWORD: 400,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  INVALID_PIN: 401,
  FORBIDDEN: 403,
  PICKUP_NOT_ALLOWED: 403,
  GUARDIAN_BLOCKED: 403,
  NOT_FOUND: 404,
  CARD_NOT_FOUND: 404,
  CARD_REVOKED: 404,
  OWNER_INACTIVE: 404,
  INVALID_STATE: 409,
  STALE_PRESENCE: 409,
  EMAIL_IN_USE: 409,
  LOGIN_IN_USE: 409,
  CREDENTIAL_MISMATCH: 409,
  CODE_IN_USE: 409,
  UID_IN_USE: 409,
  QUEUE_PENDING: 409,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  RATE_LIMITED: 429,
  EMAIL_DISABLED: 503,
  INTERNAL: 500,
};

export interface ApiError {
  error: { code: ErrorCode; message: string; details?: unknown };
}
export interface ValidationDetails {
  issues: { path: string; message: string }[];
}
export interface RateLimitDetails {
  retryAfterSeconds: number;
}

// ---------------------------------------------------------------------------
// Card codes and NFC uids
// ---------------------------------------------------------------------------

/** Unambiguous alphabet for printed codes (no 0/O, 1/I/L). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

/** Normalize a typed/scanned code: uppercase, keep only letters and digits. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Pretty print as XXXX-XXXX. */
export function formatCode(code: string): string {
  const c = normalizeCode(code);
  return c.length === CODE_LENGTH ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

export function isValidCode(code: string): boolean {
  const c = normalizeCode(code);
  return c.length === CODE_LENGTH && [...c].every((ch) => CODE_ALPHABET.includes(ch));
}

/** Characters a user may type that can never be part of a valid code. */
export const CODE_INVALID_CHARS = '01ILO';

/** Normalize an NFC serial number: lowercase hex, no separators. */
export function normalizeUid(serial: string): string {
  return serial.toLowerCase().replace(/[^0-9a-f]/g, '');
}

/**
 * Extract a card code from whatever a scanner returns: a full card URL
 * (`https://host/c/ABCD2345`), a bare code (`ABCD-2345`) or an NDEF text.
 * Returns null when nothing looks like a code.
 */
export function parseCardContent(content: string): string | null {
  const trimmed = content.trim();
  const urlMatch = trimmed.match(/\/c\/([A-Za-z0-9-]{8,10})(?:[/?#]|$)/);
  if (urlMatch) {
    const code = normalizeCode(urlMatch[1]);
    return isValidCode(code) ? code : null;
  }
  const bare = normalizeCode(trimmed);
  return isValidCode(bare) ? bare : null;
}

/** URL printed in the QR code and written to the NFC tag. */
export function cardUrl(appUrl: string, code: string): string {
  return `${appUrl.replace(/\/+$/, '')}/c/${normalizeCode(code)}`;
}

// ---------------------------------------------------------------------------
// Dates (both sides must agree on "today")
// ---------------------------------------------------------------------------

/** Civil date (YYYY-MM-DD) of an instant in a time zone. */
export function civilDate(iso: string | Date, timeZone: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Civil date of "now" in a time zone. */
export function todayCivil(timeZone: string, now: Date = new Date()): string {
  return civilDate(now, timeZone);
}

/** Add days to a civil date (YYYY-MM-DD), TZ-agnostic. */
export function addDays(civil: string, days: number): string {
  const [y, m, d] = civil.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** DD/MM/YYYY in the daycare zone. */
export function formatDate(iso: string | Date, timeZone: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

/** HH:MM (or HH:MM:SS) in the daycare zone. */
export function formatTime(iso: string | Date, timeZone: string, withSeconds = false): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hour12: false,
  }).format(d);
}

/** "10/09/2026 às 17:32" in the daycare zone. */
export function formatDateTime(iso: string | Date, timeZone: string): string {
  return `${formatDate(iso, timeZone)} às ${formatTime(iso, timeZone)}`;
}

/** Format a civil date (YYYY-MM-DD) as DD/MM/YYYY without time zone math. */
export function formatCivilDate(civil: string): string {
  const [y, m, d] = civil.split('-');
  return `${d}/${m}/${y}`;
}

/** Whether a link allows pickup on a given civil date. */
export function pickupAllowed(
  link: { canPickup: boolean; validFrom?: string | null; validUntil?: string | null; blocked?: boolean },
  todayIso: string
): boolean {
  if (link.blocked) return false;
  if (!link.canPickup) return false;
  if (link.validFrom && link.validFrom > todayIso) return false;
  if (link.validUntil && link.validUntil < todayIso) return false;
  return true;
}

/** Whether a one-off pickup authorization is valid on a civil date. */
export function authorizationValid(
  auth: { validFrom: string; validUntil: string; revokedAt: string | null },
  todayIso: string
): boolean {
  if (auth.revokedAt) return false;
  return auth.validFrom <= todayIso && todayIso <= auth.validUntil;
}

// ---------------------------------------------------------------------------
// DTOs (responses)
// ---------------------------------------------------------------------------

export interface AppConfig {
  daycareName: string;
  daycarePhone: string | null;
  timezone: string;
  appUrl: string;
  vapidPublicKey: string | null;
  emailEnabled: boolean;
  /** Build identifier of the web bundle the server is serving. */
  appVersion: string;
  /** Bumped on every change that affects the gate directory (links, credentials, children, authorizations). */
  directoryVersion: number;
  demoData: boolean;
  notifyHoldSeconds: number;
  offlineCheckoutMaxAgeHours: number;
}

export interface UserDTO {
  id: string;
  name: string;
  email: string | null;
  login: string | null;
  phone: string | null;
  role: Role;
  photoUrl: string | null;
  active: boolean;
  /** Has a password (can sign in). */
  hasAccess: boolean;
  /** Guards: has a PIN for quick switch. */
  hasPin: boolean;
  createdAt: string;
  anonymizedAt: string | null;
}

export interface AuthResult {
  token: string;
  user: UserDTO;
  expiresAt: string;
}

/** Guardian link as seen by another guardian (no photo, no contacts). */
export interface GuardianLink {
  id: string;
  name: string;
  relationship: Relationship;
  relationshipLabel: string;
  canPickup: boolean;
  isPrimary: boolean;
  validFrom: string | null;
  validUntil: string | null;
  /** Computed by the server for the daycare's civil "today"; the web recomputes offline with pickupAllowed(). */
  pickupAllowedNow: boolean;
}

/** Guardian link as seen at the gate. */
export interface GuardianLinkGate extends GuardianLink {
  photoUrl: string | null;
  blocked: boolean;
}

/** Guardian link as seen by admin. */
export interface GuardianLinkAdmin extends GuardianLinkGate {
  email: string | null;
  login: string | null;
  phone: string | null;
  hasAccess: boolean;
  blockedReason: string | null;
  createdAt: string;
  /** How this guardian can be reached by alerts. */
  reachable: 'push' | 'email' | 'inapp' | 'none';
}

export interface PickupAuthorizationDTO {
  id: string;
  childId: string;
  personName: string;
  /** Admin only; null elsewhere. */
  personDocument: string | null;
  relationshipLabel: string;
  phone: string | null;
  validFrom: string;
  validUntil: string;
  note: string | null;
  createdBy: { id: string; name: string; relationshipLabel: string | null };
  createdAt: string;
  revokedAt: string | null;
  /** Valid for the daycare's civil "today". */
  validNow: boolean;
}

export interface AttendanceEventDTO {
  id: string;
  batchId: string;
  clientId: string | null;
  childId: string;
  childName: string;
  type: EventType;
  guardianId: string | null;
  guardianName: string | null;
  guardianRelationship: Relationship | null;
  /** Free text when the person is not a registered guardian. */
  personName: string | null;
  /** Admin only; null for other roles. */
  personDocument: string | null;
  documentChecked: boolean;
  authorizationId: string | null;
  /** "autorizada por Maria (mãe)" when authorizationId is set. */
  authorizedByName: string | null;
  guardId: string;
  guardName: string;
  method: Method;
  credentialId: string | null;
  override: boolean;
  conflict: 'already_present' | 'already_out' | null;
  queued: boolean;
  note: string | null;
  occurredAt: string;
  createdAt: string;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
}

export interface ChildStatus {
  present: boolean;
  /** When the child entered (if present). */
  since: string | null;
  lastEvent: AttendanceEventDTO | null;
  /** Present since a previous civil day (missing checkout). */
  stale: boolean;
}

/** Base child projection (all roles). */
export interface ChildDTO {
  id: string;
  name: string;
  birthDate: string | null;
  className: string | null;
  shift: Shift | null;
  photoUrl: string | null;
  active: boolean;
  status: ChildStatus;
  createdAt: string;
}

/** Child as seen at the gate. */
export interface ChildGateDTO extends ChildDTO {
  gateAlert: string | null;
  guardians: GuardianLinkGate[];
  /** Only authorizations valid today (and not revoked). */
  authorizedPersons: PickupAuthorizationDTO[];
}

/** Child as seen by admin. */
export interface ChildAdminDTO extends ChildGateDTO {
  notes: string | null;
  guardians: GuardianLinkAdmin[];
  consentAt: string | null;
  consentByName: string | null;
  consentRelationship: Relationship | null;
  deactivatedAt: string | null;
  anonymizedAt: string | null;
  credentials: CredentialDTO[];
  recentEvents: AttendanceEventDTO[];
  /** All non-revoked authorizations (including future/expired ones within 30 days). */
  authorizations: PickupAuthorizationDTO[];
}

/** Child as seen by one of its guardians. */
export interface MyChildDTO extends ChildDTO {
  myRelationship: Relationship;
  myCanPickup: boolean;
  guardians: GuardianLink[];
  authorizedPersons: PickupAuthorizationDTO[];
}

export interface CredentialDTO {
  id: string;
  ownerType: OwnerType;
  ownerId: string;
  ownerName: string;
  ownerClassName: string | null;
  /** Normalized 8-char code (UI formats with formatCode). */
  code: string | null;
  /** Normalized lowercase hex. */
  nfcUid: string | null;
  label: string | null;
  active: boolean;
  createdAt: string;
  revokedAt: string | null;
}

/** Child as returned inside a guardian scan result. */
export interface ScanChildDTO extends ChildGateDTO {
  relationship: Relationship;
  relationshipLabel: string;
  canPickup: boolean;
  blocked: boolean;
  pickupAllowedNow: boolean;
}

export type ScanLookupResult =
  | {
      kind: 'guardian';
      matchedBy: 'code' | 'nfc_uid' | 'search';
      credentialId: string | null;
      guardian: { id: string; name: string; photoUrl: string | null };
      children: ScanChildDTO[];
    }
  | {
      kind: 'child';
      matchedBy: 'code' | 'nfc_uid' | 'search';
      credentialId: string | null;
      child: ChildGateDTO;
      guardians: GuardianLinkGate[];
      authorizedPersons: PickupAuthorizationDTO[];
    };

/** Offline directory for the guard app. No contact data, no notes. */
export interface ScanDirectory {
  generatedAt: string;
  version: number;
  /** Includes credentials revoked in the last 90 days (active=false) so the app can say "cancelada". */
  credentials: {
    id: string;
    ownerType: OwnerType;
    ownerId: string;
    code: string | null;
    nfcUid: string | null;
    active: boolean;
    revokedAt: string | null;
  }[];
  guardians: { id: string; name: string; photoUrl: string | null; active: boolean }[];
  children: ChildGateDTO[];
}

export interface TodaySummary {
  date: string;
  presentCount: number;
  stalePresentCount: number;
  checkinsToday: number;
  checkoutsToday: number;
  present: ChildGateDTO[];
  stale: ChildGateDTO[];
  events: AttendanceEventDTO[];
}

export interface EventsPage {
  items: AttendanceEventDTO[];
  total: number;
}

export type EventItemStatus = 'created' | 'duplicate' | 'rejected';

export interface EventItemResult {
  clientId: string;
  childId: string;
  status: EventItemStatus;
  event?: AttendanceEventDTO;
  error?: { code: ErrorCode; message: string; currentStatus?: ChildStatus };
}

export interface CreateEventsResult {
  batchId: string;
  /** Until when POST /attendance/events/:id/void suppresses notifications entirely. Null when nothing was created. */
  undoUntil: string | null;
  results: EventItemResult[];
  warnings: string[];
}

export interface NotificationDTO {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  override: boolean;
  batchId: string | null;
  events: AttendanceEventDTO[];
  childIds: string[];
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsPage {
  items: NotificationDTO[];
  unreadCount: number;
  nextBefore: string | null;
}

export interface Preferences {
  notifyCheckinPush: boolean;
  notifyCheckinEmail: boolean;
}

export interface DailyReportRow {
  child: { id: string; name: string; className: string | null; shift: Shift | null };
  checkin: AttendanceEventDTO | null;
  checkout: AttendanceEventDTO | null;
  /** Present without checkout at report time. */
  pending: boolean;
}

export interface DailyReport {
  date: string;
  rows: DailyReportRow[];
  absent: { id: string; name: string; className: string | null; shift: Shift | null; absentStreakDays: number }[];
  overrides: AttendanceEventDTO[];
  conflicts: AttendanceEventDTO[];
  denied: AttendanceEventDTO[];
  voided: AttendanceEventDTO[];
}

export interface FrequencyRow {
  child: { id: string; name: string; className: string | null; shift: Shift | null };
  daysPresent: number;
  absences: number;
  absentStreakDays: number;
  percent: number;
}

export interface FrequencyReport {
  month: string; // YYYY-MM
  schoolDays: number;
  rows: FrequencyRow[];
}

export interface GateStatus {
  sessionId: string;
  guardId: string;
  guardName: string;
  queuedCount: number;
  oldestQueuedAt: string | null;
  appVersion: string | null;
  at: string;
}

export interface AdminStats {
  presentNow: number;
  stalePresentCount: number;
  checkinsToday: number;
  checkoutsToday: number;
  childrenActive: number;
  guardiansActive: number;
  guardiansWithoutAccess: number;
  childrenWithoutReachableGuardian: number;
  childrenWithoutConsent: number;
  childrenAbsent5Days: { id: string; name: string; className: string | null; absentStreakDays: number }[];
  staleChildren: ChildGateDTO[];
  recentOverrides: AttendanceEventDTO[];
  recentConflicts: AttendanceEventDTO[];
  recentDenied: AttendanceEventDTO[];
  notifications: {
    failedLast24h: number;
    skippedLast24h: number;
    emailsToday: number;
    emailDailyLimit: number;
    emailEnabled: boolean;
    pushEnabled: boolean;
  };
  gate: GateStatus[];
  lastBackupAt: string | null;
  demoData: boolean;
}

export interface DaycareSettings {
  daycareName: string;
  daycarePhone: string | null;
  contactEmail: string | null;
}

export interface InviteResult {
  /** Whether an e-mail was sent. */
  sent: boolean;
  /** Always present so the admin can share it by WhatsApp / QR. */
  inviteUrl: string;
  whatsappUrl: string | null;
  expiresAt: string;
  kind: 'invite' | 'reset';
}

export interface UserDetailDTO extends UserDTO {
  children: {
    id: string;
    name: string;
    className: string | null;
    photoUrl: string | null;
    relationship: Relationship;
    canPickup: boolean;
    isPrimary: boolean;
    blocked: boolean;
    validFrom: string | null;
    validUntil: string | null;
  }[];
  credentials: CredentialDTO[];
  preferences: Preferences | null;
  pushSubscriptions: number;
  lastEmailError: string | null;
  sessions: number;
}

export interface AuditEntry {
  id: string;
  at: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  details: unknown;
  ip: string | null;
}

export interface AuditPage {
  items: AuditEntry[];
  nextBefore: string | null;
}

export interface AdminNotificationRow {
  id: string;
  userId: string;
  userName: string;
  kind: NotificationKind;
  channel: NotificationChannel;
  status: NotificationStatus;
  error: string | null;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
}

export interface ImportRowResult {
  line: number;
  action: 'create_child' | 'link_existing' | 'create_guardian' | 'skip';
  childName: string;
  guardianName: string | null;
  errors: string[];
}

export interface ImportResult {
  dryRun: boolean;
  rows: ImportRowResult[];
  summary: { childrenCreated: number; guardiansCreated: number; linksCreated: number; skipped: number; errors: number };
}

// ---------------------------------------------------------------------------
// Request schemas (zod)
// ---------------------------------------------------------------------------

const email = z.string().trim().toLowerCase().email('E-mail inválido');
const password = z.string().min(8, 'A senha deve ter pelo menos 8 caracteres').max(200);
const name = z.string().trim().min(2, 'Nome muito curto').max(120);
const phone = z.string().trim().max(40).nullable().optional();
const login = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,30}$/, 'Login: use 3 a 30 letras, números, ponto, traço ou sublinhado');
const pin = z.string().regex(/^\d{4,6}$/, 'PIN: 4 a 6 dígitos');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (use AAAA-MM-DD)');
export const isoMonth = z.string().regex(/^\d{4}-\d{2}$/, 'Mês inválido (use AAAA-MM)');
export const isoDateTime = z.string().datetime({ offset: true });
export const uuid = z.string().uuid();

export const LoginBody = z.object({
  /** e-mail or login */
  identifier: z.string().trim().min(1).max(200),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof LoginBody>;

export const SwitchGuardBody = z.object({ userId: uuid, pin });
export type SwitchGuardBody = z.infer<typeof SwitchGuardBody>;

export const AcceptInviteBody = z.object({ token: z.string().min(20), password });
export type AcceptInviteBody = z.infer<typeof AcceptInviteBody>;

export const ForgotPasswordBody = z.object({ identifier: z.string().trim().min(1).max(200) });
export const ResetPasswordBody = z.object({ token: z.string().min(20), password });
export const ChangePasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: password });

export const CreateUserBody = z
  .object({
    name,
    email: email.nullable().optional(),
    login: login.nullable().optional(),
    phone,
    role: z.enum(ROLES),
    /** Only for admin/guard. Guardians always get an invite/reset link. */
    password: password.optional(),
    pin: pin.optional(),
    /** Send invite e-mail now (default true when e-mail present and no password). */
    sendInvite: z.boolean().optional(),
  })
  .refine((b) => b.role === 'guardian' || b.email || b.login, {
    message: 'Informe e-mail ou login',
    path: ['email'],
  })
  .refine((b) => !(b.role === 'guardian' && b.password), {
    message: 'Responsáveis definem a própria senha pelo convite',
    path: ['password'],
  });
export type CreateUserBody = z.infer<typeof CreateUserBody>;

export const UpdateUserBody = z.object({
  name: name.optional(),
  email: email.nullable().optional(),
  login: login.nullable().optional(),
  phone,
  active: z.boolean().optional(),
  /** Only for admin/guard. */
  password: password.optional(),
});
export type UpdateUserBody = z.infer<typeof UpdateUserBody>;

export const SetPinBody = z.object({ pin });
export const UpdateMeBody = z.object({ name: name.optional(), phone });
export const AnonymizeBody = z.object({ reason: z.string().trim().min(3).max(500) });

export const CreateChildBody = z.object({
  name,
  birthDate: isoDate.nullable().optional(),
  className: z.string().trim().max(60).nullable().optional(),
  shift: z.enum(SHIFTS).nullable().optional(),
  gateAlert: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  consentAt: isoDate.nullable().optional(),
  consentByName: z.string().trim().max(120).nullable().optional(),
  consentRelationship: z.enum(CONSENT_RELATIONSHIPS).nullable().optional(),
});
export type CreateChildBody = z.infer<typeof CreateChildBody>;

export const UpdateChildBody = CreateChildBody.partial().extend({ active: z.boolean().optional() });
export type UpdateChildBody = z.infer<typeof UpdateChildBody>;

/** PUT /children/:id/guardians/:userId */
export const ChildGuardianBody = z.object({
  relationship: z.enum(RELATIONSHIPS),
  canPickup: z.boolean(),
  isPrimary: z.boolean().default(false),
  validFrom: isoDate.nullable().optional(),
  validUntil: isoDate.nullable().optional(),
  blocked: z.boolean().default(false),
  blockedReason: z.string().trim().max(500).nullable().optional(),
});
export type ChildGuardianBody = z.infer<typeof ChildGuardianBody>;

/** POST /children/:id/guardians — create a brand new guardian and link it. */
export const CreateGuardianForChildBody = ChildGuardianBody.extend({
  name,
  email: email.nullable().optional(),
  phone,
  sendInvite: z.boolean().optional(),
});
export type CreateGuardianForChildBody = z.infer<typeof CreateGuardianForChildBody>;

export const PickupAuthorizationBody = z
  .object({
    personName: name,
    personDocument: z.string().trim().max(60).nullable().optional(),
    relationshipLabel: z.string().trim().min(2).max(60),
    phone,
    /** Defaults to today (daycare TZ). */
    validFrom: isoDate.optional(),
    /** Defaults to validFrom. Max 30 days after validFrom. */
    validUntil: isoDate.optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine((b) => !b.validFrom || !b.validUntil || b.validUntil >= b.validFrom, {
    message: 'Validade final antes da inicial',
    path: ['validUntil'],
  });
export type PickupAuthorizationBody = z.infer<typeof PickupAuthorizationBody>;

export const CreateCredentialBody = z.object({
  ownerType: z.enum(OWNER_TYPES),
  ownerId: uuid,
  label: z.string().trim().max(60).nullable().optional(),
  /** Optional: bind an NFC uid at creation. */
  nfcUid: z.string().trim().min(4).max(64).optional(),
});
export type CreateCredentialBody = z.infer<typeof CreateCredentialBody>;

export const BulkCredentialsBody = z.object({
  ownerType: z.enum(OWNER_TYPES),
  className: z.string().trim().max(60).optional(),
  /** Only owners without an active credential (default true). */
  onlyWithout: z.boolean().default(true),
});
export type BulkCredentialsBody = z.infer<typeof BulkCredentialsBody>;

export const BindNfcBody = z.object({ uid: z.string().trim().min(4).max(64) });

export const ScanLookupBody = z
  .object({
    uid: z.string().trim().min(4).max(64).optional(),
    code: z.string().trim().min(4).max(20).optional(),
  })
  .refine((b) => b.uid || b.code, { message: 'Informe uid ou code' });
export type ScanLookupBody = z.infer<typeof ScanLookupBody>;

export const ManualLookupBody = z.object({
  ownerType: z.enum(OWNER_TYPES),
  ownerId: uuid,
});
export type ManualLookupBody = z.infer<typeof ManualLookupBody>;

export const HeartbeatBody = z.object({
  queuedCount: z.number().int().min(0),
  oldestQueuedAt: isoDateTime.nullable().optional(),
  appVersion: z.string().max(40).nullable().optional(),
});
export type HeartbeatBody = z.infer<typeof HeartbeatBody>;

export const CreateEventsBody = z
  .object({
    type: z.enum(EVENT_TYPES),
    guardianId: uuid.nullable().optional(),
    personName: z.string().trim().min(2).max(120).nullable().optional(),
    personDocument: z.string().trim().max(60).nullable().optional(),
    documentChecked: z.boolean().optional(),
    authorizationId: uuid.nullable().optional(),
    method: z.enum(['nfc', 'qr', 'code', 'search', 'manual']),
    credentialId: uuid.nullable().optional(),
    /** Acknowledge an exception where R2 requires it (server marks override only where needed). */
    override: z.boolean().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
    /** Device time; ignored for live events (server clock wins), used for queued ones. */
    occurredAt: isoDateTime.optional(),
    queued: z.boolean().optional(),
    directoryGeneratedAt: isoDateTime.nullable().optional(),
    events: z.array(z.object({ clientId: uuid, childId: uuid })).min(1).max(20),
  })
  .refine((b) => b.guardianId || b.personName, { message: 'Informe o responsável ou o nome da pessoa', path: ['guardianId'] })
  .refine((b) => !b.override || (b.note && b.note.length >= 10), {
    message: 'A exceção exige uma observação de pelo menos 10 caracteres',
    path: ['note'],
  })
  .refine((b) => !(b.type === 'checkout' && !b.guardianId && !b.authorizationId) || b.override, {
    message: 'Saída com pessoa não cadastrada exige exceção (override) ou autorização avulsa',
    path: ['override'],
  })
  .refine((b) => {
    const unique = new Set(b.events.map((e) => e.clientId));
    return unique.size === b.events.length;
  }, { message: 'clientId repetido', path: ['events'] });
export type CreateEventsBody = z.infer<typeof CreateEventsBody>;

export const VoidEventBody = z.object({ reason: z.string().trim().min(3).max(500) });
export type VoidEventBody = z.infer<typeof VoidEventBody>;

export const BackfillBody = z.object({
  rows: z
    .array(
      z
        .object({
          clientId: uuid,
          childId: uuid,
          type: z.enum(['checkin', 'checkout']),
          guardianId: uuid.nullable().optional(),
          personName: z.string().trim().min(2).max(120).nullable().optional(),
          /** One-off pickup authorization the person on the sheet was covered by (checkout without guardianId). */
          authorizationId: uuid.nullable().optional(),
          /** Acknowledge an exception (R2) for this row; requires a note of at least 10 characters. */
          override: z.boolean().optional(),
          occurredAt: isoDateTime,
          note: z.string().trim().max(1000).nullable().optional(),
        })
        .refine((r) => r.guardianId || r.personName, { message: 'Informe o responsável ou o nome da pessoa', path: ['guardianId'] })
        .refine((r) => !r.override || (r.note && r.note.length >= 10), {
          message: 'A exceção exige uma observação de pelo menos 10 caracteres',
          path: ['note'],
        })
    )
    .min(1)
    .max(500),
});
export type BackfillBody = z.infer<typeof BackfillBody>;

export const EventsQuery = z.object({
  childId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  type: z.enum(EVENT_TYPES).optional(),
  includeVoided: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type EventsQuery = z.infer<typeof EventsQuery>;

export const PreferencesBody = z.object({
  notifyCheckinPush: z.boolean().optional(),
  notifyCheckinEmail: z.boolean().optional(),
});

export const PushSubscriptionBody = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  expirationTime: z.number().nullable().optional(),
});
export type PushSubscriptionBody = z.infer<typeof PushSubscriptionBody>;

export const UnsubscribePushBody = z.object({ endpoint: z.string().url() });

export const ReadNotificationsBody = z.object({ ids: z.array(uuid).optional() });

export const DaycareSettingsBody = z.object({
  daycareName: z.string().trim().min(2).max(120).optional(),
  daycarePhone: z.string().trim().max(40).nullable().optional(),
  contactEmail: email.nullable().optional(),
});

// ---------------------------------------------------------------------------
// Push payload (server → service worker)
// ---------------------------------------------------------------------------

export interface PushPayload {
  title: string;
  body: string;
  /** e.g. /alertas?n=<notificationId> */
  url: string;
  /** e.g. batch:<batchId> so sibling alerts collapse. */
  tag: string;
  notificationId: string;
  kind: NotificationKind;
  override: boolean;
}

// ---------------------------------------------------------------------------
// Offline queue item (web-only shape, shared so tests and future tooling agree)
// ---------------------------------------------------------------------------

export const QUEUE_SCHEMA_VERSION = 2;

export interface QueueItem {
  batchId: string;
  schemaVersion: number;
  body: CreateEventsBody;
  /** Names for the UI while offline. */
  summary: { type: EventType; childNames: string[]; personName: string };
  status: 'pending' | 'sending' | 'sent' | 'rejected' | 'needs_login';
  attempts: number;
  createdAt: string;
  lastError: string | null;
  result: CreateEventsResult | null;
}

// ---------------------------------------------------------------------------
// Helpers shared by both sides
// ---------------------------------------------------------------------------

export function relationshipLabel(r: Relationship | string | null | undefined): string {
  if (!r) return '';
  return (RELATIONSHIP_LABELS as Record<string, string>)[r] ?? r;
}

/** "Ana e Pedro", "Ana, Pedro e João", "Ana, Pedro, João +2". */
export function joinNames(names: string[], max = 3): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
  return `${names.slice(0, max).join(', ')} +${names.length - max}`;
}

/** First name + surname initial, for printed cards. */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** Remove accents and lower-case for name search. */
export function searchKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Deterministic pre-selection rule for the gate confirmation screen.
 * P = present (not stale), F = out or stale.
 */
export function suggestAction(children: { id: string; status: ChildStatus }[]): {
  action: 'checkin' | 'checkout' | 'mixed';
  selected: string[];
  present: string[];
  out: string[];
} {
  const present = children.filter((c) => c.status.present && !c.status.stale).map((c) => c.id);
  const out = children.filter((c) => !c.status.present || c.status.stale).map((c) => c.id);
  if (out.length > 0 && present.length === 0) return { action: 'checkin', selected: out, present, out };
  if (present.length > 0 && out.length === 0) return { action: 'checkout', selected: present, present, out };
  if (children.length === 0) return { action: 'checkin', selected: [], present, out };
  return { action: 'mixed', selected: [], present, out };
}

/** Brazilian phone to E.164 digits for wa.me links (best effort). */
export function whatsappDigits(phoneRaw: string | null | undefined): string | null {
  if (!phoneRaw) return null;
  let digits = phoneRaw.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  if (!digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) digits = `55${digits}`;
  return digits.length >= 12 && digits.length <= 13 ? digits : null;
}
