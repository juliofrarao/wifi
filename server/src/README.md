# Creche Segura — server

Fastify 5 + better-sqlite3 + TypeScript (ESM, Node 22). Everything the web app
consumes is typed in `@creche/shared`; this package implements the API. Where the
prose spec and the contract disagree, the contract (`shared/src/index.ts`) and the
schema (`db/schema.sql`) win.

Run: `npm run dev` (tsx watch) · `npm run build` (tsc + copies `schema.sql` into
`dist/db/`) · `npm start` (`node dist/index.js`) · `npm test` (node:test, in-memory
SQLite) · `npm run typecheck` · `npm run seed [-- --force | --clean]` ·
`npm run purge` · `npm run restore -- <snapshot> --yes`.
In production the scripts also run from `dist/`: `node dist/seed.js`, `node dist/purge.js`,
`node dist/restore.js`.

## Module map

```
src/
  index.ts                 entry: .env → config → data dirs → openDb → seedSettings →
                           ensureInitialAdmin (refuses example/short password) → real Notifier →
                           buildApp → startJobs → listen; graceful SIGINT/SIGTERM
  config.ts                zod-parsed env → Config (all vars in .env.example, spec defaults);
                           resolveDir(): relative DATA_DIR / WEB_DIST are tried against the cwd, the
                           server package and the repo root (first existing wins), so `npm start`,
                           `node server/dist/index.js` from the root and Docker all work
  context.ts               AppDeps (what callers provide) and Ctx (what routes receive)
  app.ts                   buildApp(deps): multipart (2 MiB), error handler, /api routes,
                           static WEB_DIST + SPA fallback, version.json → AppConfig.appVersion
  bootstrap.ts             seedSettings() (daycare info from env only when absent, VAPID keys,
                           files_secret, directory_version=1), ensureInitialAdmin()
  jobs.ts                  startJobs(deps) → { stop } — backup scheduler, hourly housekeeping,
                           notification dispatcher (every 5 s)
  seed.ts                  demo data (spec §12): runSeed / cleanSeed / hasRealData, CLI --force/--clean
  purge.ts / restore.ts    LGPD retention script; snapshot restore script
  db/
    schema.sql             the schema (source of truth)
    index.ts               openDb(path | ':memory:'), tx(db, fn), one/all/run/placeholders helpers
    settings.ts            getSetting/setSetting/…, bumpDirectoryVersion(), SETTING_KEYS
    rows.ts                row interfaces (UserRow, ChildRow, LinkRow, EventRow, NotificationRow, …)
  lib/
    errors.ts              ApiError(code, message?, details?) + ERROR_MESSAGES (pt-BR)
    validate.ts            parse(schema, data) → ApiError('VALIDATION'); queryBool/Int/Str
    crypto.ts              scrypt, sha256Hex, randomToken, hmacSignature, randomCode
    time.ts                todayCivil, normalizeIso, zonedParts/zonedToUtc, dayStartIso, dayEndIso,
                           dayRange, civilDayRange, minusMonthsIso, plusMs(Iso)
    audit.ts               audit(db, actor, action, entityType, entityId, details?, ip?, now?)
    ratelimit.ts           LIMITS, identifierKey/ipKey/lookupKey, assertNotLimited, recordFailure, …
    photos.ts              detectImage, storePhoto, removePhoto, deleteFile, photoUrl
    png.ts                 dependency-free PNG encoder + avatarPng(seed) (seed placeholder photos)
  auth/                    sessions.ts, plugin.ts (req.now, req.auth, requireRole, actorOf), routes.ts
  services/
    email.ts               createMailer/createFakeMailer, invite/reset/test texts, isTransientMailError
    push.ts                createPush/createFakePush; send(row, payload) → { ok, gone }
    notifications/
      index.ts             Notifier interface, createStubNotifier (records only), withRecording,
                           re-exports createNotifier / dispatchOnce / startDispatcher
      templates.ts         pt-BR texts per spec §6: renderAttendance/Void/GuardianAdded/
                           AuthorizationAdded/CredentialRevoked/System → { title, body, pushBody, html, subject, highlighted }
      fanout.ts            createNotifier(deps): recipients (R8/R9/R16), channelsFor, insertNotificationRows,
                           attendanceBatch / eventVoided / guardianAdded / authorizationAdded /
                           credentialRevoked / adminAlert; batchEvents(db, batchId)
      dispatcher.ts        dispatchOnce(deps) / startDispatcher(deps): inapp → sent, push (gone → delete sub),
                           e-mail with retries 60/300 s then failed, daily quota, admin warning once a day
    attendance.ts          createEvents (batch algorithm R1–R15), voidEvent, backfillEvents, todaySummary,
                           queryEvents (R10 role rules), eventsCsv (§10), insertEventRow, statusAt, autoCloseInstant
    scan.ts                lookupByCard, lookupManual, buildDirectory, directoryEtag, recordHeartbeat,
                           guardianResult/childResult (ScanLookupResult builders)
    reports.ts             dailyReport, frequencyReport, frequencyCsv
    invites.ts status.ts absence.ts backup.ts anonymize.ts users.ts csv.ts import.ts   (S1, unchanged
                           except absence.ts: check-ins after `now` are ignored so past-day reports work)
  dto/                     users.ts children.ts credentials.ts authorizations.ts events.ts (role projections)
  routes/
    config.ts public.ts files.ts me.ts users.ts children.ts credentials.ts admin.ts upload.ts   (S1)
    scan.ts                GET /scan/directory (ETag/304), POST /scan/lookup, /scan/manual, /scan/heartbeat
    attendance.ts          POST /attendance/events, /events/:id/void, /backfill; GET /today, /events, /events.csv
    reports.ts             GET /reports/daily?date=, GET /reports/frequency?month=&className=&format=csv
    notifications.ts       GET /me/notifications?limit=&before=, POST /me/notifications/read
```

## AppDeps / Ctx

```ts
interface AppDeps { db: Db; config: Config; mailer: Mailer; push: PushService; notifier: Notifier; now?: () => Date }
interface Ctx extends AppDeps { now: () => Date; filesSecret: string; log: FastifyBaseLogger; appVersion: string }
```

`index.ts` builds the deps with the real mailer/push and
`createNotifier({ db, config, now, emailEnabled, pushEnabled })`; tests
(`test/helpers.ts`) use `createFakeMailer()` (records to `outbox`),
`createFakePush()` (records to `sent`), the real notifier wrapped with
`withRecording` (rows are written **and** `notifier.calls` is available) and a
controllable clock. `buildApp` calls `seedSettings()` itself.

Every request handler uses `req.now` as "now" — never `new Date()` directly —
and `req.auth` (set by the auth hook). Protected routes declare
`{ preHandler: requireRole('admin', 'guard') }`.

## Notifications (S2)

- **Rows**: `notifications` has one row per (recipient, channel); attendance
  batches are unique per `(user_id, batch_id, channel)` (partial index) so a batch
  never notifies twice. `child_ids` is the recipient's subset of the batch
  (a guardian of Ana only is told about Ana, not her sibling). `event_id` is the
  first event of that subset (or the voided event). `override = 1` marks
  highlighted alerts (exceptions, conflicts, refusals, revoked cards); the
  dispatcher lets those bypass the e-mail quota. `payload_json` holds
  `{ url, tag, inappId }` for push rows and `{ html, subject, inappId }` for e-mail rows
  (`url = /alertas?n=<inapp row id>`, `tag = batch:<batchId>`).
- **Recipients**: guardians with a live, non-blocked link whose user is active;
  admins additionally when the batch is highlighted. `guardianAdded` excludes
  the new person, `authorizationAdded` excludes the creator, `credentialRevoked`
  notifies the owner (or the child's guardians for a child card).
- **Channels** (`channelsFor`): `inapp` always; `push` when the user has
  subscriptions (and VAPID keys exist); `email` whenever the user has an e-mail —
  when SMTP is not configured the dispatcher marks the row `skipped`
  (`email_disabled`), so the office can see what was not delivered (R8; the e2e
  asserts this). Routine check-ins follow `notify_checkin_push` /
  `notify_checkin_email`. Late backfills (> 3 h) skip push; automatic closings
  (`inappOnly`) and quota warnings (`noEmail`) narrow further.
- **Hold**: attendance rows get `dispatch_after = now + NOTIFY_HOLD_SECONDS`
  (`undoUntil`); R16 kinds, voids, system alerts dispatch immediately;
  automatic closings are not undoable and dispatch immediately.
- **Void** (`voidEvent`): if no row of the batch was delivered yet, the pending
  rows are skipped (`error = 'voided'`) — or regenerated for the siblings that
  remain live, keeping the original `dispatch_after`; if something was already
  delivered, still-pending rows for that child are skipped and a `void`
  notification ("Registro cancelado") goes to the guardians (and admins when
  the event was highlighted), with the channel policy of the original kind.
- **Dispatcher**: every 5 s, `pending` rows with `dispatch_after ≤ now` and
  `attempts < 3` (100 per tick). Push: any subscription ok → `sent`; all gone →
  `skipped (gone)` and the subscriptions are deleted; otherwise retry like
  e-mail. E-mail: `skipped` with `email_disabled` / `no_email` / `inactive` /
  `quota`; transient errors (`isTransientMailError`: 4xx SMTP, timeouts) retry
  after 60 s then 300 s, the third failure marks `failed` (the spec's 1800 s
  step never applies with `attempts < 3`); permanent errors fail immediately and
  set `users.last_email_error` (cleared on the next success). Quota = e-mails
  `sent` today (`sent_at` in the civil day) ≥ `SMTP_DAILY_LIMIT`; admins are warned
  once per civil day (`settings.quota_warned_day`) by inapp/push only.
- `AdminStats.notifications` (S1 queries) matches: failed/skipped by `created_at`
  in the last 24 h, e-mails today by `sent_at` (verified in test/notifications.test.ts).

## Attendance (S2)

- `createEvents` runs in one transaction: resolve guardian/person/authorization;
  R15 (`nfc|qr|code` need a credential of the guardian or of a child in the batch,
  else `CREDENTIAL_MISMATCH`; `search|manual` need none); R6 `occurred_at` (live =
  server clock; queued = device time inside `[now − 7 d, now + 2 min]` else server
  time + warning; backfill = given, ≤ now else `OCCURRED_AT_INVALID`); batch id =
  new UUID or the batch of the first replayed `clientId`; then per item R4 → R5
  (60 s, same type/child/person/guard, voided ignored) → blocked link (checkout
  → `GUARDIAN_BLOCKED`, `denied` and check-in accepted) → R1 → R2 → insert with
  snapshots. Rejected items never interrupt the batch.
- R1: a stale child's check-in first inserts an automatic checkout (own batch,
  `method 'auto'`, `person_name 'Sistema'`, `note 'Fechamento automático: saída não
  registrada em DD/MM'`, `occurred_at` = 23:59:59.999 of the entry day in `TZ`,
  inapp-only notification). Live conflicts → `INVALID_STATE` with `currentStatus`;
  queued conflicts are stored with `conflict`. Live check-out of a stale child
  without note → `STALE_PRESENCE`; a queued one is accepted (the true record is
  never lost). Backfill evaluates the state **at `occurred_at`** (`statusAt`).
- R2: allowed by a live, non-blocked link with pickup valid on the civil day of
  `occurred_at` (user active), or by an authorization of that child valid on that
  day and not revoked before it. Otherwise `override: true` + note (≥ 10) marks
  `override = 1` **only on that child**; else `PICKUP_NOT_ALLOWED` with a reason.
- R11: revoked card on a live event → every item `rejected CARD_REVOKED`; on a
  queued event whose `occurred_at` is after the revocation → `override = 1` and
  the note gets "carteirinha revogada em DD/MM HH:MM"; before the revocation →
  normal record.
- Snapshots: `guardian_relationship` comes from the live link (null when the
  guardian is not linked to that child — check-in still accepted), `authorized_by_name`
  = "Maria (mãe)" / "Direção (secretaria)". An unlinked registered guardian is
  treated as "not allowed" on check-out.
- Backfill groups rows by (type, person, occurredAt, note) into batches (siblings
  share one alert), processes groups in chronological order, uses `method 'manual'`,
  and answers the first created batch id. A check-out by an unregistered person on
  paper is recorded as an exception (override with an office note). Rows older
  than 3 h notify by inapp + e-mail with "Registro lançado às HH:MM pela secretaria".
- Void: guards up to 24 h after `created_at`, admins always; already-voided events
  answer 200 idempotently (the app retries per event). Audit `event.void`.
- `GET /attendance/events`: guard `from` is clamped to today − 7 d; guardians must
  pass `childId` of a child they have a live, non-blocked link to; `includeVoided`
  defaults to false (the route normalizes the string before zod's coerce).
- CSV: BOM, `;`, CRLF, `occurred_at ASC`, from/to default today, ≤ 366 days,
  voided rows included (`cancelado = sim`), `documento` present (admin export).

## Gate (S2)

- `lookup`: code first (normalized; invalid shape = miss), then uid; a revoked
  card answers `CARD_REVOKED` without falling through; code and uid resolving to
  different owners → `CREDENTIAL_MISMATCH`; inactive/anonymized owner →
  `OWNER_INACTIVE`. Only `CARD_NOT_FOUND` and `CREDENTIAL_MISMATCH` count toward
  the per-session limit (20 / 10 min); `manual` counts `NOT_FOUND`.
- Directory: active children (gate projection), guardians = active users with a
  live link to an active child, credentials = active ones of active owners +
  revoked in the last 90 days. `ETag = "<version>-<today>-<last event change>"`
  so it also changes when statuses change (a superset of "version + minute");
  `If-None-Match` → 304. `Cache-Control: private, no-cache`.
- Heartbeat upserts `gate_heartbeats` by session.

## Reports (S2)

- Daily: rows for children with events that day (first check-in, last check-out —
  a real check-out beats an automatic closing), `pending` = check-in without
  check-out; `absent` = active children without events, streaks computed as of
  the end of that day; overrides/conflicts/denied (non-voided) and voided lists.
- Frequency: school days = civil days of the month with ≥ 1 non-voided check-in
  in the unit; absences only count school days on/after the child's registration;
  `percent` rounded to 0.1; `absentStreakDays` as of now. `?format=csv` →
  `crianca;turma;turno;dias_letivos;dias_presentes;faltas;dias_seguidos_ausente;percentual`.

## Seed (S2)

`npm run seed` / `node dist/seed.js`. Every demo row id starts with `d3a0d3a0-`
(deterministic sha256-derived, v4-shaped), which is how `--clean` removes only demo
rows (and their photo files). Refuses to run when non-demo children, non-admin
users or events exist (`--force` overrides; admins from `ADMIN_*` do not count).
Re-running replaces the demo data. Data: admin `admin@demo.local / demo-admin-123`,
guards `carlos` (PIN 1234) / `ana` (PIN 5678) with `demo-guard-123`, 3 classes, 12
children, 20 guardians (Maria `maria@demo.local / demo-maria-123`, others
`demo-<first>-123` or no password / no e-mail), codes `AAAA-2222` (Maria) …, a
revoked `AAAA-9999`, NFC uids on Maria/Fernanda/Ana, 5 school days of events
(today included after 07:00 local on weekdays), Gabriel stale since the last
school day, Laura's override, Davi's refused pickup, Lucas's queued conflict,
Helena's voided tap, Isabela absent 5+ days, Sofia without photo, Rosa authorized
today for Ana. Maria's children have **not** arrived today so the e2e flow can
start with their ENTRADA. Past alerts are stored as delivered (`sent`);
`settings.demo_data = 1`.

## Behaviour notes / decisions (S1, still valid)

- `GET /auth/guards` lists active guards **that have a PIN**.
- `POST /auth/switch` locks the current session after 5 wrong PINs and ends the
  current session on success.
- `POST /users` always creates an invite token for users created without a password.
- `PATCH /users/:id` with `password` or `active:false` revokes sessions/push.
- Anonymizing a user soft-removes their live links.
- `PATCH /children/:id { active: false }` on a present child inserts the R17
  automatic checkout (`auto`, `Sistema`, `Desligamento`) with no notifications.
- R16 in `PUT /children/:id/guardians/:userId`: `notifier.guardianAdded` fires
  when pickup becomes allowed or the validity is extended; blocking never notifies.
- Pickup authorizations: ≤ 30 days, not in the past; guardians need `pickupAllowed` today.
- Gate and guardian projections hide links whose user is inactive; guardians also
  never see blocked links.
- Import matching by `searchKey(name)` (+ birth date) / e-mail / (name, phone).
- Backups: `creche-YYYY-MM-DD-HHmm.sqlite`, rotation by mtime, 02:00 local.
- Static serving only when `WEB_DIST/index.html` exists. `index.html`, `sw.js`,
  `manifest.webmanifest` and `version.json` are `no-cache`; `/assets/*` immutable;
  every other GET that is not `/api/*` gets `index.html` (SPA fallback).

## Known gaps

- The 5 s dispatcher loop and the 02:00 backup scheduler are not covered by timing
  tests (`dispatchOnce` is tested directly).
- Audit paging cursor is `at` only (S1); the notification feed cursor is
  `created_at` but pulls in every row sharing the last millisecond, so nothing is skipped.
