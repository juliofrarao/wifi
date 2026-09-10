/**
 * Typed functions for every route in spec §10. Thin wrappers over api().
 * Guardian/admin functions are here for W2; gate functions are used by /portaria.
 */
import type {
  AcceptInviteBody,
  AdminNotificationRow,
  AdminStats,
  AppConfig,
  AttendanceEventDTO,
  AuditPage,
  AuthResult,
  BackfillBody,
  BulkCredentialsBody,
  ChildAdminDTO,
  ChildGateDTO,
  ChildGuardianBody,
  CreateChildBody,
  CreateCredentialBody,
  CreateEventsBody,
  CreateEventsResult,
  CreateGuardianForChildBody,
  CreateUserBody,
  CredentialDTO,
  DailyReport,
  DaycareSettings,
  EventsPage,
  EventsQuery,
  FrequencyReport,
  GateStatus,
  HeartbeatBody,
  ImportResult,
  InviteResult,
  LoginBody,
  ManualLookupBody,
  MyChildDTO,
  NotificationsPage,
  PickupAuthorizationBody,
  PickupAuthorizationDTO,
  Preferences,
  PushSubscriptionBody,
  Role,
  ScanDirectory,
  ScanLookupBody,
  ScanLookupResult,
  SwitchGuardBody,
  TodaySummary,
  UpdateChildBody,
  UpdateUserBody,
  UserDTO,
  UserDetailDTO,
} from '@creche/shared';
import { api, apiBlob, apiRaw, type RequestOptions } from './client';

type AnonymizeBody = { reason: string };

type Opts = Pick<RequestOptions, 'timeoutMs' | 'signal' | 'silent'>;

// ---- Public -------------------------------------------------------------------

export const getConfig = (opts?: Opts) => api<AppConfig>('/config', { auth: false, ...opts });
export const login = (body: LoginBody) => api<AuthResult>('/auth/login', { method: 'POST', body, auth: false });
export const acceptInvite = (body: AcceptInviteBody) =>
  api<AuthResult>('/auth/accept-invite', { method: 'POST', body, auth: false });
export const getInvite = (token: string) =>
  api<{ name: string; role: Role; expiresAt: string }>(`/auth/invite/${encodeURIComponent(token)}`, { auth: false });
export const forgotPassword = (identifier: string) =>
  api<void>('/auth/forgot-password', { method: 'POST', body: { identifier }, auth: false });
export const getReset = (token: string) => api<{ name: string }>(`/auth/reset/${encodeURIComponent(token)}`, { auth: false });
export const resetPassword = (token: string, password: string) =>
  api<AuthResult>('/auth/reset-password', { method: 'POST', body: { token, password }, auth: false });
export const getPublicCard = (code: string) =>
  api<{ daycareName: string; daycarePhone: string | null }>(`/public/cards/${encodeURIComponent(code)}`, { auth: false });

// ---- Session (all roles) --------------------------------------------------------

export const logout = () => api<void>('/auth/logout', { method: 'POST', timeoutMs: 5000, silent: true });
export const getMe = (opts?: Opts) => api<{ user: UserDTO }>('/auth/me', opts);
export const changePassword = (currentPassword: string, newPassword: string) =>
  api<void>('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
export const updateMe = (body: { name?: string; phone?: string | null }) => api<UserDTO>('/me', { method: 'PATCH', body });

// ---- Gate (guard, admin) --------------------------------------------------------

export const getGuards = () => api<{ id: string; name: string; photoUrl: string | null }[]>('/auth/guards');
export const switchGuard = (body: SwitchGuardBody) => api<AuthResult>('/auth/switch', { method: 'POST', body });

/** Raw response so the caller can handle ETag / 304 / X-SW-Cache. */
export const getDirectoryRaw = (etag: string | null, opts?: Opts) =>
  apiRaw('/scan/directory', {
    headers: etag ? { 'If-None-Match': etag } : {},
    timeoutMs: 20_000,
    silent: true,
    ...opts,
  });
export const getDirectory = () => api<ScanDirectory>('/scan/directory');
export const scanLookup = (body: ScanLookupBody, opts?: Opts) =>
  api<ScanLookupResult>('/scan/lookup', { method: 'POST', body, timeoutMs: 3000, ...opts });
export const manualLookup = (body: ManualLookupBody, opts?: Opts) =>
  api<ScanLookupResult>('/scan/manual', { method: 'POST', body, timeoutMs: 3000, ...opts });
export const heartbeat = (body: HeartbeatBody) =>
  api<void>('/scan/heartbeat', { method: 'POST', body, timeoutMs: 4000, silent: true });

export const createEvents = (body: CreateEventsBody, opts?: Opts) =>
  api<CreateEventsResult>('/attendance/events', { method: 'POST', body, ...opts });
export const voidEvent = (id: string, reason: string) =>
  api<AttendanceEventDTO>(`/attendance/events/${encodeURIComponent(id)}/void`, { method: 'POST', body: { reason } });
export const backfill = (body: BackfillBody) => api<CreateEventsResult>('/attendance/backfill', { method: 'POST', body });
export const getToday = () => api<TodaySummary>('/attendance/today');
export const listEvents = (query: Partial<EventsQuery>) => api<EventsPage>('/attendance/events', { query });
export const downloadEventsCsv = (query: { from?: string; to?: string; childId?: string }) =>
  apiBlob('/attendance/events.csv', { query });

// ---- Children --------------------------------------------------------------------

export const listChildren = <T = ChildGateDTO>(query: { q?: string; className?: string; includeInactive?: boolean } = {}) =>
  api<T[]>('/children', { query });
export const createChild = (body: CreateChildBody) => api<ChildAdminDTO>('/children', { method: 'POST', body });
export const getChild = <T = ChildAdminDTO | ChildGateDTO | MyChildDTO>(id: string) =>
  api<T>(`/children/${encodeURIComponent(id)}`);
export const updateChild = (id: string, body: UpdateChildBody) =>
  api<ChildAdminDTO>(`/children/${encodeURIComponent(id)}`, { method: 'PATCH', body });
export const uploadChildPhoto = (id: string, form: FormData) =>
  api<{ photoUrl: string }>(`/children/${encodeURIComponent(id)}/photo`, { method: 'POST', body: form, timeoutMs: 60_000 });
export const createGuardianForChild = (id: string, body: CreateGuardianForChildBody) =>
  api<{ child: ChildAdminDTO; guardian: UserDTO; invite: InviteResult | null }>(`/children/${encodeURIComponent(id)}/guardians`, {
    method: 'POST',
    body,
  });
export const putChildGuardian = (childId: string, userId: string, body: ChildGuardianBody) =>
  api<ChildAdminDTO>(`/children/${encodeURIComponent(childId)}/guardians/${encodeURIComponent(userId)}`, { method: 'PUT', body });
export const removeChildGuardian = (childId: string, userId: string) =>
  api<ChildAdminDTO>(`/children/${encodeURIComponent(childId)}/guardians/${encodeURIComponent(userId)}`, { method: 'DELETE' });
export const listPickupAuthorizations = (childId: string, includeExpired = false) =>
  api<PickupAuthorizationDTO[]>(`/children/${encodeURIComponent(childId)}/pickup-authorizations`, {
    query: { includeExpired: includeExpired || undefined },
  });
export const createPickupAuthorization = (childId: string, body: PickupAuthorizationBody) =>
  api<PickupAuthorizationDTO>(`/children/${encodeURIComponent(childId)}/pickup-authorizations`, { method: 'POST', body });
export const revokePickupAuthorization = (childId: string, authId: string) =>
  api<void>(`/children/${encodeURIComponent(childId)}/pickup-authorizations/${encodeURIComponent(authId)}`, { method: 'DELETE' });
export const anonymizeChild = (id: string, body: AnonymizeBody) =>
  api<void>(`/children/${encodeURIComponent(id)}/anonymize`, { method: 'POST', body });

// ---- Users (admin) -------------------------------------------------------------------

export const listUsers = (query: { role?: Role; q?: string; includeInactive?: boolean } = {}) => api<UserDTO[]>('/users', { query });
export const createUser = (body: CreateUserBody) => api<{ user: UserDTO; invite: InviteResult | null }>('/users', { method: 'POST', body });
export const getUser = (id: string) => api<UserDetailDTO>(`/users/${encodeURIComponent(id)}`);
export const updateUser = (id: string, body: UpdateUserBody) => api<UserDTO>(`/users/${encodeURIComponent(id)}`, { method: 'PATCH', body });
export const inviteUser = (id: string) => api<InviteResult>(`/users/${encodeURIComponent(id)}/invite`, { method: 'POST' });
export const uploadUserPhoto = (id: string, form: FormData) =>
  api<{ photoUrl: string }>(`/users/${encodeURIComponent(id)}/photo`, { method: 'POST', body: form, timeoutMs: 60_000 });
export const setUserPin = (id: string, pin: string) => api<void>(`/users/${encodeURIComponent(id)}/pin`, { method: 'POST', body: { pin } });
export const revokeUserSessions = (id: string) => api<void>(`/users/${encodeURIComponent(id)}/sessions/revoke`, { method: 'POST' });
export const anonymizeUser = (id: string, body: AnonymizeBody) =>
  api<void>(`/users/${encodeURIComponent(id)}/anonymize`, { method: 'POST', body });

// ---- Credentials -----------------------------------------------------------------------

export const listCredentials = (
  query: { ownerType?: 'guardian' | 'child'; ownerId?: string; className?: string; includeRevoked?: boolean } = {}
) => api<CredentialDTO[]>('/credentials', { query });
export const createCredential = (body: CreateCredentialBody) => api<CredentialDTO>('/credentials', { method: 'POST', body });
export const bulkCredentials = (body: BulkCredentialsBody) =>
  api<{ created: CredentialDTO[] }>('/credentials/bulk', { method: 'POST', body });
export const bindNfc = (id: string, uid: string) =>
  api<CredentialDTO>(`/credentials/${encodeURIComponent(id)}/nfc`, { method: 'POST', body: { uid } });
export const revokeCredential = (id: string) => api<CredentialDTO>(`/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });

// ---- Reports & admin ---------------------------------------------------------------------

export const getDailyReport = (date?: string) => api<DailyReport>('/reports/daily', { query: { date } });
export const getFrequencyReport = (month: string, className?: string) =>
  api<FrequencyReport>('/reports/frequency', { query: { month, className } });
export const downloadFrequencyCsv = (month: string, className?: string) =>
  apiBlob('/reports/frequency', { query: { month, className, format: 'csv' } });
export const getAdminStats = () => api<AdminStats>('/admin/stats');
export const getSettings = () => api<DaycareSettings>('/admin/settings');
export const updateSettings = (body: Partial<DaycareSettings>) => api<DaycareSettings>('/admin/settings', { method: 'PATCH', body });
export const sendTestEmail = () => api<void>('/admin/test-email', { method: 'POST', timeoutMs: 30_000 });
export const getAudit = (query: { limit?: number; before?: string } = {}) => api<AuditPage>('/admin/audit', { query });
export const getAdminNotifications = (query: { status?: string; limit?: number } = {}) =>
  api<AdminNotificationRow[]>('/admin/notifications', { query });
export const getGateStatus = () => api<GateStatus[]>('/admin/gate-status');
export const runBackup = () => api<{ lastBackupAt: string }>('/admin/backup', { method: 'POST', timeoutMs: 120_000 });
export const downloadBackup = () => apiBlob('/admin/backup', { timeoutMs: 300_000 });
export const importCsv = (file: File | Blob, dryRun: boolean) => {
  const fd = new FormData();
  fd.append('file', file, 'importacao.csv');
  return api<ImportResult>('/admin/import', { method: 'POST', body: fd, query: { dryRun }, timeoutMs: 120_000 });
};
export const downloadImportTemplate = () => apiBlob('/admin/import/template.csv');

// ---- Guardian ("me") -------------------------------------------------------------------------

export const getMyChildren = () => api<MyChildDTO[]>('/me/children');
export const getMyNotifications = (query: { limit?: number; before?: string } = {}) =>
  api<NotificationsPage>('/me/notifications', { query });
export const markNotificationsRead = (ids?: string[]) =>
  api<{ unreadCount: number }>('/me/notifications/read', { method: 'POST', body: ids ? { ids } : {} });
export const getPreferences = () => api<Preferences>('/me/preferences');
export const updatePreferences = (body: Partial<Preferences>) => api<Preferences>('/me/preferences', { method: 'PATCH', body });
export const registerPushSubscription = (body: PushSubscriptionBody) =>
  api<{ id: string }>('/me/push-subscriptions', { method: 'POST', body });
export const unregisterPushSubscription = (endpoint: string) =>
  api<void>('/me/push-subscriptions/unsubscribe', { method: 'POST', body: { endpoint } });
export const sendTestPush = () => api<void>('/me/push-subscriptions/test', { method: 'POST' });
