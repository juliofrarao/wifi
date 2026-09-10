/**
 * Local status overlay (pure): directory statuses + events this device
 * recorded since directory.generatedAt (sent or not).
 */
import { civilDate, type AttendanceEventDTO, type ChildGateDTO, type ChildStatus, type EventType, type Method, type Relationship } from '@creche/shared';

/** An event recorded on this device (persisted in IndexedDB "localEvents"). */
export interface LocalEvent {
  clientId: string;
  batchId: string;
  childId: string;
  childName: string;
  type: EventType;
  /** Device time at confirmation; replaced by the server's occurredAt once sent. */
  occurredAt: string;
  guardianId: string | null;
  guardianName: string | null;
  guardianRelationship: Relationship | null;
  personName: string | null;
  guardId: string;
  guardName: string;
  method: Method;
  /** Set when the batch was accepted by the server. */
  sentAt: string | null;
  /** Server event id (for void/undo). */
  serverEventId: string | null;
  /** Undone / voided locally: no longer counts. */
  voided: boolean;
}

/** Synthesises an AttendanceEventDTO-shaped object for a local event (UI "quem deixou"). */
export function localEventToDto(e: LocalEvent): AttendanceEventDTO {
  return {
    id: e.serverEventId ?? e.clientId,
    batchId: e.batchId,
    clientId: e.clientId,
    childId: e.childId,
    childName: e.childName,
    type: e.type,
    guardianId: e.guardianId,
    guardianName: e.guardianName,
    guardianRelationship: e.guardianRelationship,
    personName: e.personName,
    personDocument: null,
    documentChecked: false,
    authorizationId: null,
    authorizedByName: null,
    guardId: e.guardId,
    guardName: e.guardName,
    method: e.method,
    credentialId: null,
    override: false,
    conflict: null,
    queued: e.sentAt === null,
    note: null,
    occurredAt: e.occurredAt,
    createdAt: e.occurredAt,
    voidedAt: e.voided ? e.occurredAt : null,
    voidedBy: null,
    voidReason: null,
  };
}

/** Recomputes `stale` for the current civil day (the directory computed it at generatedAt). */
export function recomputeStale(status: ChildStatus, today: string, timeZone: string): ChildStatus {
  if (!status.present || !status.since) return { ...status, stale: false };
  const stale = civilDate(status.since, timeZone) < today;
  return status.stale === stale ? status : { ...status, stale };
}

/**
 * Applies this device's events on top of a base status.
 *  - `baseAt`: when the base status was computed (directory.generatedAt or the
 *    live lookup time). Sent events older than that are already reflected.
 *  - Unsent events always apply.
 */
export function applyOverlay(
  base: ChildStatus,
  baseAt: string | null,
  events: LocalEvent[],
  childId: string,
  today: string,
  timeZone: string
): ChildStatus {
  const relevant = events
    .filter((e) => e.childId === childId && !e.voided && e.type !== 'denied')
    .filter((e) => e.sentAt === null || baseAt === null || e.occurredAt > baseAt)
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
  const last = relevant[relevant.length - 1];
  if (!last) return recomputeStale(base, today, timeZone);
  if (last.type === 'checkin') {
    return {
      present: true,
      since: last.occurredAt,
      lastEvent: localEventToDto(last),
      stale: civilDate(last.occurredAt, timeZone) < today,
    };
  }
  return { present: false, since: null, lastEvent: localEventToDto(last), stale: false };
}

export interface PresenceCounts {
  present: number;
  stale: number;
}

/** presentCount excludes stale (R12); stale counted separately. */
export function countPresence(children: ChildGateDTO[], statusOf: (childId: string) => ChildStatus): PresenceCounts {
  let present = 0;
  let stale = 0;
  for (const c of children) {
    if (!c.active) continue;
    const s = statusOf(c.id);
    if (!s.present) continue;
    if (s.stale) stale++;
    else present++;
  }
  return { present, stale };
}

/**
 * Which local events to keep after a directory refresh: unsent ones, and sent
 * ones newer than the directory (older sent ones are reflected already).
 * Voided events are dropped once older than the directory.
 */
export function pruneLocalEvents(events: LocalEvent[], generatedAt: string | null, unsentBatchIds: Set<string>): LocalEvent[] {
  return events.filter((e) => {
    if (unsentBatchIds.has(e.batchId)) return true;
    if (e.sentAt === null) return true;
    if (generatedAt === null) return true;
    return e.occurredAt > generatedAt;
  });
}
