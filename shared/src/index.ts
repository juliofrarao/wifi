/**
 * Creche Segura — shared API contract.
 *
 * Everything the server exposes and the web app consumes is typed here.
 * Request bodies are validated with the zod schemas; responses use the DTO
 * interfaces. Keep this file free of Node/browser-only APIs.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const ROLES = ['admin', 'guard', 'guardian'] as const;
export type Role = (typeof ROLES)[number];

export const EVENT_TYPES = ['checkin', 'checkout'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const METHODS = ['nfc', 'qr', 'code', 'manual'] as const;
export type Method = (typeof METHODS)[number];

export const CREDENTIAL_KINDS = ['code', 'nfc_uid'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export const OWNER_TYPES = ['guardian', 'child'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

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

/** Human labels (pt-BR) for relationships. */
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
  manual: 'Manual',
};

export const NOTIFICATION_CHANNELS = ['inapp', 'push', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Card codes
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
// DTOs (responses)
// ---------------------------------------------------------------------------

export interface AppConfig {
  daycareName: string;
  daycarePhone: string | null;
  timezone: string;
  appUrl: string;
  vapidPublicKey: string | null;
  emailEnabled: boolean;
}

export interface UserDTO {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  photoUrl: string | null;
  active: boolean;
  createdAt: string;
  /** Only for guardians. */
  hasPassword?: boolean;
}

/** Guardian as seen from a child (link info included). */
export interface GuardianLinkDTO {
  id: string;
  name: string;
  photoUrl: string | null;
  relationship: Relationship;
  relationshipLabel: string;
  canPickup: boolean;
  isPrimary: boolean;
  validUntil: string | null; // ISO date (YYYY-MM-DD)
  /** false when validUntil has passed. */
  pickupAllowedNow: boolean;
  /** Only for admin. */
  email?: string;
  phone?: string | null;
  hasPassword?: boolean;
}

export interface AttendanceEventDTO {
  id: string;
  clientId: string | null;
  childId: string;
  childName: string;
  type: EventType;
  guardianId: string | null;
  guardianName: string | null;
  guardianRelationship: Relationship | null;
  /** Free text when the person is not a registered guardian. */
  personName: string | null;
  guardId: string;
  guardName: string;
  method: Method;
  credentialId: string | null;
  override: boolean;
  note: string | null;
  occurredAt: string; // ISO UTC
  createdAt: string;
}

export interface ChildStatus {
  present: boolean;
  /** When the child entered (if present). */
  since: string | null;
  lastEvent: AttendanceEventDTO | null;
  /** True when present since a previous calendar day (missing checkout). */
  stale: boolean;
}

export interface ChildDTO {
  id: string;
  name: string;
  birthDate: string | null;
  className: string | null;
  notes: string | null;
  photoUrl: string | null;
  active: boolean;
  status: ChildStatus;
  guardians: GuardianLinkDTO[];
  createdAt: string;
}

export interface ChildDetailDTO extends ChildDTO {
  credentials?: CredentialDTO[]; // admin only
  recentEvents: AttendanceEventDTO[];
}

export interface CredentialDTO {
  id: string;
  ownerType: OwnerType;
  ownerId: string;
  ownerName: string;
  kind: CredentialKind;
  /** Formatted code (XXXX-XXXX) or normalized UID. */
  value: string;
  label: string | null;
  active: boolean;
  createdAt: string;
  revokedAt: string | null;
}

/** Child as returned inside a guardian scan result. */
export interface ScanChildDTO extends ChildDTO {
  relationship: Relationship;
  relationshipLabel: string;
  canPickup: boolean;
  pickupAllowedNow: boolean;
}

export type ScanLookupResult =
  | {
      kind: 'guardian';
      matchedBy: CredentialKind | 'manual';
      credentialId: string | null;
      guardian: { id: string; name: string; photoUrl: string | null };
      children: ScanChildDTO[];
    }
  | {
      kind: 'child';
      matchedBy: CredentialKind | 'manual';
      credentialId: string | null;
      child: ChildDTO;
      guardians: GuardianLinkDTO[];
    };

/** Offline directory for the guard app. No contact data. */
export interface ScanDirectory {
  generatedAt: string;
  credentials: { id: string; kind: CredentialKind; value: string; ownerType: OwnerType; ownerId: string }[];
  guardians: { id: string; name: string; photoUrl: string | null }[];
  children: ChildDTO[];
}

export interface TodaySummary {
  date: string; // YYYY-MM-DD in daycare TZ
  presentCount: number;
  checkinsToday: number;
  checkoutsToday: number;
  present: ChildDTO[];
  events: AttendanceEventDTO[];
}

export interface NotificationDTO {
  id: string;
  eventId: string;
  event: AttendanceEventDTO;
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

export interface CreateEventsResult {
  events: AttendanceEventDTO[];
  /** Events that already existed (idempotent replay). */
  duplicates: number;
  warnings: string[];
}

export interface DailyReportRow {
  child: { id: string; name: string; className: string | null };
  checkin: AttendanceEventDTO | null;
  checkout: AttendanceEventDTO | null;
  durationMinutes: number | null;
  /** Present without checkout at report time. */
  pending: boolean;
}

export interface DailyReport {
  date: string;
  rows: DailyReportRow[];
  absent: { id: string; name: string; className: string | null }[];
  overrides: AttendanceEventDTO[];
}

export interface AdminStats {
  presentNow: number;
  checkinsToday: number;
  checkoutsToday: number;
  childrenActive: number;
  guardiansActive: number;
  guardiansWithoutPassword: number;
  staleChildren: ChildDTO[];
  recentOverrides: AttendanceEventDTO[];
  notifications: { failedLast24h: number; skippedLast24h: number; emailEnabled: boolean; pushEnabled: boolean };
}

export interface DaycareSettings {
  daycareName: string;
  daycarePhone: string | null;
}

export interface InviteResult {
  sent: boolean;
  /** Present when e-mail is disabled so the admin can share the link manually. */
  inviteUrl: string | null;
  expiresAt: string;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

// ---------------------------------------------------------------------------
// Request schemas (zod)
// ---------------------------------------------------------------------------

const email = z.string().trim().toLowerCase().email('E-mail inválido');
const password = z.string().min(8, 'A senha deve ter pelo menos 8 caracteres').max(200);
const name = z.string().trim().min(2, 'Nome muito curto').max(120);
const phone = z.string().trim().max(40).nullable().optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (use AAAA-MM-DD)');
const isoDateTime = z.string().datetime({ offset: true });
export const uuid = z.string().uuid();

export const LoginBody = z.object({ email, password: z.string().min(1) });
export type LoginBody = z.infer<typeof LoginBody>;

export const AcceptInviteBody = z.object({ token: z.string().min(10), password });
export type AcceptInviteBody = z.infer<typeof AcceptInviteBody>;

export const ForgotPasswordBody = z.object({ email });
export const ResetPasswordBody = z.object({ token: z.string().min(10), password });
export const ChangePasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: password });

export const CreateUserBody = z.object({
  name,
  email,
  phone,
  role: z.enum(ROLES),
  /** Optional: when absent an invite is sent. */
  password: password.optional(),
  /** Send invite e-mail now (default true when no password). */
  sendInvite: z.boolean().optional(),
});
export type CreateUserBody = z.infer<typeof CreateUserBody>;

export const UpdateUserBody = z.object({
  name: name.optional(),
  email: email.optional(),
  phone,
  active: z.boolean().optional(),
  /** Admin can set a new password directly (e.g. for guards without e-mail access). */
  password: password.optional(),
});
export type UpdateUserBody = z.infer<typeof UpdateUserBody>;

export const UpdateMeBody = z.object({ name: name.optional(), phone });

export const CreateChildBody = z.object({
  name,
  birthDate: isoDate.nullable().optional(),
  className: z.string().trim().max(60).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type CreateChildBody = z.infer<typeof CreateChildBody>;

export const UpdateChildBody = CreateChildBody.partial().extend({ active: z.boolean().optional() });
export type UpdateChildBody = z.infer<typeof UpdateChildBody>;

/** PUT /children/:id/guardians/:userId */
export const ChildGuardianBody = z.object({
  relationship: z.enum(RELATIONSHIPS),
  canPickup: z.boolean().default(true),
  isPrimary: z.boolean().default(false),
  validUntil: isoDate.nullable().optional(),
});
export type ChildGuardianBody = z.infer<typeof ChildGuardianBody>;

/** POST /children/:id/guardians — create a brand new guardian and link it. */
export const CreateGuardianForChildBody = ChildGuardianBody.extend({
  name,
  email,
  phone,
  sendInvite: z.boolean().optional(),
});
export type CreateGuardianForChildBody = z.infer<typeof CreateGuardianForChildBody>;

export const CreateCredentialBody = z.object({
  ownerType: z.enum(OWNER_TYPES),
  ownerId: uuid,
  kind: z.enum(CREDENTIAL_KINDS),
  /** Required for nfc_uid; generated by the server for code when absent. */
  value: z.string().trim().min(4).max(64).optional(),
  label: z.string().trim().max(60).nullable().optional(),
});
export type CreateCredentialBody = z.infer<typeof CreateCredentialBody>;

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

export const CreateEventsBody = z
  .object({
    clientId: uuid,
    childIds: z.array(uuid).min(1).max(20),
    type: z.enum(EVENT_TYPES),
    guardianId: uuid.nullable().optional(),
    personName: z.string().trim().min(2).max(120).nullable().optional(),
    personDocument: z.string().trim().max(60).nullable().optional(),
    method: z.enum(METHODS),
    credentialId: uuid.nullable().optional(),
    override: z.boolean().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
    occurredAt: isoDateTime.optional(),
  })
  .refine((b) => b.guardianId || b.personName, { message: 'Informe o responsável ou o nome da pessoa' })
  .refine((b) => !b.override || (b.note && b.note.length >= 3), {
    message: 'Exceção exige uma observação',
    path: ['note'],
  });
export type CreateEventsBody = z.infer<typeof CreateEventsBody>;

export const EventsQuery = z.object({
  childId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  type: z.enum(EVENT_TYPES).optional(),
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

export const DeletePushSubscriptionBody = z.object({ endpoint: z.string().url() });

export const ReadNotificationsBody = z.object({ ids: z.array(uuid).optional() });

export const DaycareSettingsBody = z.object({
  daycareName: z.string().trim().min(2).max(120).optional(),
  daycarePhone: z.string().trim().max(40).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Push payload (server → service worker)
// ---------------------------------------------------------------------------

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  eventId: string;
  type: EventType;
  override: boolean;
}

// ---------------------------------------------------------------------------
// Helpers shared by both sides
// ---------------------------------------------------------------------------

export function relationshipLabel(r: Relationship | string | null | undefined): string {
  if (!r) return '';
  return (RELATIONSHIP_LABELS as Record<string, string>)[r] ?? r;
}

/** Whether a link allows pickup at the given instant (ISO date compare in TZ-agnostic way). */
export function pickupAllowed(link: { canPickup: boolean; validUntil: string | null }, todayIso: string): boolean {
  if (!link.canPickup) return false;
  if (!link.validUntil) return true;
  return link.validUntil >= todayIso;
}
