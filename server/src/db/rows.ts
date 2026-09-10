/** Row shapes exactly as stored (snake_case, integers for booleans). */
import type { EventType, Method, NotificationChannel, NotificationKind, NotificationStatus, OwnerType, Relationship, Role, Shift } from '@creche/shared';

export interface FileRow {
  id: string;
  mime: string;
  size: number;
  path: string;
  created_by: string | null;
  created_at: string;
}

export interface UserRow {
  id: string;
  name: string;
  email: string | null;
  login: string | null;
  phone: string | null;
  role: Role;
  password_hash: string | null;
  pin_hash: string | null;
  photo_file_id: string | null;
  active: number;
  notify_checkin_push: number;
  notify_checkin_email: number;
  last_email_error: string | null;
  password_set_at: string | null;
  anonymized_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChildRow {
  id: string;
  name: string;
  birth_date: string | null;
  class_name: string | null;
  shift: Shift | null;
  gate_alert: string | null;
  notes: string | null;
  photo_file_id: string | null;
  active: number;
  deactivated_at: string | null;
  consent_at: string | null;
  consent_by_name: string | null;
  consent_relationship: Relationship | null;
  anonymized_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LinkRow {
  id: string;
  child_id: string;
  user_id: string;
  relationship: Relationship;
  can_pickup: number;
  is_primary: number;
  valid_from: string | null;
  valid_until: string | null;
  blocked: number;
  blocked_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  removed_at: string | null;
  removed_by: string | null;
}

/** child_guardians joined with the guardian's user row (prefixed `u_`). */
export interface LinkWithUserRow extends LinkRow {
  u_name: string;
  u_email: string | null;
  u_login: string | null;
  u_phone: string | null;
  u_photo_file_id: string | null;
  u_active: number;
  u_password_hash: string | null;
  u_push_count: number;
}

export interface AuthorizationRow {
  id: string;
  child_id: string;
  person_name: string;
  person_document: string | null;
  relationship_label: string;
  phone: string | null;
  valid_from: string;
  valid_until: string;
  note: string | null;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

/** pickup_authorizations joined with the creator (`c_`) and the creator's live link to the child. */
export interface AuthorizationWithCreatorRow extends AuthorizationRow {
  c_name: string;
  c_relationship: Relationship | null;
}

export interface CredentialRow {
  id: string;
  owner_type: OwnerType;
  owner_id: string;
  code: string | null;
  nfc_uid: string | null;
  label: string | null;
  active: number;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface CredentialWithOwnerRow extends CredentialRow {
  owner_name: string;
  owner_class_name: string | null;
}

export interface EventRow {
  id: string;
  client_id: string | null;
  batch_id: string;
  child_id: string;
  child_name: string;
  type: EventType;
  guardian_id: string | null;
  guardian_name: string | null;
  guardian_relationship: Relationship | null;
  person_name: string | null;
  person_document: string | null;
  document_checked: number;
  authorization_id: string | null;
  authorized_by_name: string | null;
  guard_id: string;
  guard_name: string;
  method: Method;
  credential_id: string | null;
  override: number;
  conflict: 'already_present' | 'already_out' | null;
  queued: number;
  directory_at: string | null;
  note: string | null;
  occurred_at: string;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
}

export interface NotificationRow {
  id: string;
  user_id: string;
  kind: NotificationKind;
  batch_id: string | null;
  event_id: string | null;
  child_ids: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  title: string;
  body: string;
  override: number;
  payload_json: string | null;
  error: string | null;
  attempts: number;
  dispatch_after: string;
  read_at: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  switch_failures: number;
}

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  session_id: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  last_success_at: string | null;
  last_error: string | null;
}

export interface AuthTokenRow {
  id: string;
  user_id: string;
  kind: 'invite' | 'reset';
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface AuditRow {
  id: string;
  at: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details_json: string | null;
  ip: string | null;
}

export interface GateHeartbeatRow {
  session_id: string;
  user_id: string;
  queued_count: number;
  oldest_queued_at: string | null;
  app_version: string | null;
  at: string;
}

export const bool = (v: number | boolean | null | undefined): boolean => v === 1 || v === true;
