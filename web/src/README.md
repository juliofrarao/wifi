# Creche Segura — web app (`web/`)

Vite + React 19 + TypeScript + react-router 7 (imported from `'react-router'`), one
JS bundle, plain CSS in `rem`. All UI strings are Brazilian Portuguese; code and
comments are English. The API contract lives in `@creche/shared` (`shared/src/index.ts`).

```
npm run dev -w web        # Vite on :5173, /api proxied to :3000 (API_URL overrides)
npm run build -w web      # tsc --noEmit + vite build → web/dist (+ dist/version.json)
npm test -w web           # node:test over test/*.test.ts (pure logic only, no DOM)
node web/scripts/make-icons.mjs   # regenerates public/icons/*.png (no deps)
```

`__APP_VERSION__` (see `vite.config.ts`) is `<git sha>-<UTC yyyymmddHHMM>` for builds
(`build-<time>` without git, `dev` for the dev server) and is also written to
`dist/version.json` so the server can report `AppConfig.appVersion`.

## Folder map

| Path | What |
| --- | --- |
| `index.html`, `public/manifest.webmanifest`, `public/icons/` | PWA shell (lang pt-BR, viewport without maximum-scale, theme-color). |
| `public/sw.js` | Service worker (plain JS, scope `/`): precache from index.html, network-first index/directory, cache-first assets and `/api/files/*` (≤ 600), push + notificationclick, `precache-photos` / `refresh-precache` / `skip-waiting` messages. Registered in production only (`main.tsx`) as `/sw.js?v=<version>` so every build re-installs it. |
| `src/main.tsx` | Providers: `BrowserRouter > ConfigProvider > AuthProvider > ToastProvider > App`. |
| `src/App.tsx` | Routes exactly as spec §7 (public, gate, guardian, admin). |
| `src/styles/global.css` | Design tokens (`--c-entrada`, `--c-saida`, `--c-danger`, greys, type scale, `--tap` 48px), layout (`.shell*`), components (`.btn`, `.avatar`, `.banner`, `.chip`, `.badge`, `.field`, `.checkrow`, `.list-item`, `.sheet`, `.toast`, `.table`), gate screens, reduced motion, print. |
| `src/api/client.ts` | `api()`, `apiRaw()`, `apiBlob()`, `ApiError`, token helpers, events. |
| `src/api/endpoints.ts` | One typed function per route of spec §10. |
| `src/config/ConfigProvider.tsx` | `useConfig()` → `{ config, loaded, offline, updateAvailable, refresh, applyUpdate }`. |
| `src/auth/AuthProvider.tsx` | `useAuth()` → `{ status, user, signIn, setSession, signOut, refreshUser }`, `homeFor(role)`. |
| `src/auth/RequireRole.tsx` | `<RequireRole roles={[...]}>` and `<HomeRedirect/>`. |
| `src/components/` | Reusable UI (list below). |
| `src/lib/` | `storage` (localStorage keys), `store` (tiny external store + `useStore`), `idb` (IndexedDB wrapper + gate DB), `formatters` (pure `makeFormatters(tz)`, testable) + `format` (`useFormat()` bound to the daycare TZ), `form` (`validateWith(schema)`, `issuesFromError`, `formError`, `emptyToNull`), `tz` (`zonedToIso(civil, HH:MM, tz)`, `monthRange`), `download` (`saveBlob`, `copyText`), `vibrate`, `wakeLock`, `broadcast` (BroadcastChannel `creche-gate`), `photo` (`resizePhoto` → JPEG ≤ 512px), `ua` (in-app browser / iOS / standalone / NFC / push support), `codeField` (XXXX-XXXX formatting), `push` (subscribe/unsubscribe), `useAsync`, `useNow`. |
| `src/pages/public/` | `/login`, `/esqueci`, `/convite/:token`, `/redefinir/:token`, `/c/:code`. |
| `src/pages/guardian/` | `/inicio`, `/alertas`, `/filho/:id`, `/config` (see "Guardian app"). |
| `src/pages/admin/` | `/admin/*` (see "Admin app"); child detail lives in `criancas/`. |
| `src/admin/` | Pure admin logic: `childFilters` (list filters + `?f=` flags), `cards` (CR80 print model), `backfillLogic` (grid → `BackfillBody`). |
| `src/pages/LogoutButton.tsx` | "Sair" button honouring `QUEUE_PENDING`. |
| `src/gate/` | The gate app (see below). |
| `test/` | `node:test` unit tests for the pure modules. |

## API client

```ts
import { api, apiRaw, apiBlob, ApiError, isApiError, describeError } from '../api/client';
import { listChildren, voidEvent } from '../api/endpoints';

const kids = await listChildren({ q: 'ana' });            // GET /api/children?q=ana (Bearer token added)
await api('/me/preferences', { method: 'PATCH', body: { notifyCheckinEmail: true } });
const { blob, filename } = await apiBlob('/attendance/events.csv', { query: { from, to } });
try { await voidEvent(id, 'toque errado'); } catch (e) { if (isApiError(e) && e.code === 'FORBIDDEN') ... }
```

- Base `/api`, JSON in/out, `FormData` bodies pass through (multipart uploads), `query` object → query string.
- `timeoutMs` per call (default 10 s, `AbortController`); `signal` can be chained.
- Errors are `ApiError { code, message, status, details }`; `code` is a server `ErrorCode` or the client-only `NETWORK` / `TIMEOUT` / `BAD_RESPONSE`. `describeError(err)` gives a pt-BR string.
- A 401 `UNAUTHORIZED` on an authenticated call clears the token **and the gate directory (never the queue)** and dispatches `creche:auth-expired` on `window` (AuthProvider → `/login`). `INVALID_PIN` / `INVALID_CREDENTIALS` 401s do not log out.
- Every successful authenticated call dispatches `creche:request-ok` (a queue drain trigger) unless `silent: true`.

Data helpers: `useFormat()` gives `time / date / dateTime / civil / relative / today()` in `config.timezone`
(never format dates without it). `resizePhoto(file)` + `photoFormData(blob)` for uploads.

## Components (`src/components`)

| Component | Notes |
| --- | --- |
| `Button`, `LinkButton` | `variant`: primary · entrada · saida · danger · neutral · ghost; `size`: sm · md · big · huge; `icon`, `sub`, `loading`, `block`. |
| `Avatar` | Photo or initials; `size` sm/md/lg/xl, `square`, `noPhotoBadge` ("SEM FOTO"). |
| `Banner` | `kind` info · warn · danger · success, `actions`, `onClick` (tappable banner), `className="banner--compact"`. |
| `Modal`, `Sheet` | Centered dialog / bottom sheet; Escape + backdrop close, focus handling, `actions`. |
| `ToastProvider`, `useToast().show(text, kind?, ms?)` | Toasts at the top (never over the sticky gate buttons). |
| `Spinner` | Inline or `block` with label. |
| `TextField`, `TextArea`, `SelectField` | Label/hint/error wiring with aria attributes. |
| `CheckboxRow`, `SimpleCheckbox` | Whole-row ≥ 56 px checkbox (`role="checkbox"`), `tone` entrada/saida/danger, `hideBox`. |
| `AppShell`, `GateShell`, `GuardianShell`, `AdminShell`, `PublicShell` | Sticky header + bottom nav (side nav on ≥ 60rem for admin). `GATE_NAV`, `GUARDIAN_NAV`, `ADMIN_NAV`. |
| `QrCodeImage` | `qrcode.toDataURL` → `<img>`. |
| `EmptyState`, `ConfirmDialog` (optional required reason), `PinKeypad`, `UpdateBanner` | |
| `QueryState` | `loading/error/onRetry/hasData` wrapper: spinner, error banner with retry, or children (stale-while-revalidate when `hasData`). |
| `Tabs` | Scrollable `role="tablist"` (`items`, `value`, `onChange`, optional `badge`). |
| `EventRow` (+ `eventWho`) | One `AttendanceEventDTO` as a list row with badges (exceção/conflito/da fila/cancelado), optional child link and "Cancelar". |
| `VoidEventDialog` | Admin "Cancelar registro" with required reason → `POST /attendance/events/:id/void`. |
| `AuthorizationSheet` (+ `authorizationBadge`) | Pickup-authorization form (defaults today, max 30 days, zod-mirrored errors) → `POST /children/:id/pickup-authorizations`; used by guardians and admins. |
| `InviteSheet` | `InviteResult` sheet: e-mail sent / WhatsApp button / QR of `inviteUrl` / copy. |
| `PhotoUpload` | Camera or file → `resizePhoto` → multipart upload callback. |
| `CredentialList`, `OwnerCredentials` | Credential rows with print / "Colar NFC" / revoke / "Revogar e gerar nova"; `OwnerCredentials` loads one owner's list with `includeRevoked`. |
| `NfcBindSheet` | "Colar etiqueta NFC": `useNfcReader` (gate/nfc.ts) → `POST /credentials/:id/nfc`, optional `NDEFReader.write` of the card URL and `makeReadOnly`, with Chrome/Android-only messages. |

### Adding a page

1. Create `src/pages/<role>/MyPage.tsx` returning `<GuardianShell title="…">…</GuardianShell>` (or `AdminShell`).
2. Load data with `useAsync(() => endpointFn(...), [deps])` → `{ data, error, loading, reload }`.
3. Register the route in `src/App.tsx` inside the role layout (`GuardianLayout` / `AdminLayout` already apply `RequireRole`).
4. Dates via `useFormat()`, errors via `describeError`, feedback via `useToast()`.

## Gate app (`src/gate`)

Everything is local-first: stores are module-level (`lib/store.ts`) so workers and hardware
callbacks can update them; React reads them with `useStore` / the hooks below.

| Module | Role |
| --- | --- |
| `lookup.ts` (pure) | `findCredential(dir, {code, uid})`, `buildLookupFromDirectory(dir, ownerType, ownerId, today, opts)` (recomputes `pickupAllowedNow` / valid authorizations with `pickupAllowed` / `authorizationValid`), `guardianResultFromChild`, `refreshLookup`, `searchDirectory(dir, q, className)`, `classNamesOf`, `hasAnyNfc`. |
| `directory.ts` | IndexedDB `kv.directory` (+ ETag, fetchedAt). `refreshDirectory(reason, force)` with `If-None-Match`; refreshed on open, visibilitychange, after each successful sync (queue `sent` event), when `config.directoryVersion` changes, and manually. Posts `precache-photos` to the SW. `clearDirectory()` on 401/logout. Recent people in localStorage. `useDirectory()`. |
| `statusLogic.ts` (pure) / `status.ts` | `LocalEvent`s recorded on this device (IndexedDB `localEvents`). `applyOverlay(base, baseAt, events, childId, today, tz)`: unsent events always apply, sent ones only when newer than the base. `makeStatusResolver`, `presenceCounts` (stale excluded from present). Wired to the queue: `sent` → server ids/times; prune after directory refresh. |
| `queueLogic.ts` (pure) / `queue.ts` | `StoredQueueItem` (= shared `QueueItem` + `updatedAt`, `lastAttemptAt`) in IndexedDB `queue`. Single drain worker: FIFO, 5 s timeout, backoff 2 s→60 s, `queued: true` on retries / items older than 60 s, heartbeat on every attempt, `ok → sent`, `4xx → rejected`, `401 → needs_login`, `5xx/network → retry`. `enqueue`, `kickQueue`, `retryNeedsLogin`, `dismissNotApplied`, `removeQueueItem`, `getQueueCounts`, `useQueue()` → `{ items, counts, notApplied, late }`. |
| `undo.ts` | `{ batchId, eventIds, undoUntil }` in localStorage; `performUndo()` removes an unsent batch or POSTs `/attendance/events/:id/void` ("Desfeito pela portaria"). `useUndo()`, `undoActive()`. |
| `flow.ts` | In-memory flow: `pending` lookup, `next` ("Próximo: Fulano"), `success` (overlay), `switchSuggested`; anti-repeat (2 s duplicate, 15 s "Já registrado"); last reader mode. |
| `resolve.ts` | `resolveCard(read, deps)`: directory → revoked/mismatch/inactive messages → `POST /scan/lookup` (3 s). `resolveOwner` for search hits (`/scan/manual` fallback). |
| `nfc.ts` | `useNfcReader({ enabled, onRead, onError })` → `{ state, start, stop }` (unsupported/off/blocked/idle/listening/paused). |
| `qr.ts` | `useQrScanner({ onCode })` → `{ state, videoRef, start, stop, timedOut, engine }` (BarcodeDetector or jsQR, 30 s idle stop). |
| `GateProvider.tsx` | Mounted for `/portaria/*`: loads stores, installs triggers, tracks > 6 h hidden (→ `/portaria/trocar`), listens to the BroadcastChannel, hosts the NFC reader and the success overlay. `useGate()` → `{ directory, statusOf, counts, today, nfc, nfcVisible, handleRead, handleOwner, openLookup, finishConfirmation, cancelConfirmation, readerMessage, … }`. |
| `pages/` | `Leitura`, `Confirmar` (guardian/child/person variants, live SAÍDA verification, offline second tap, exception form, blocked screen), `Sucesso` (overlay), `Hoje`, `Historico`, `Folha`, `Trocar`. |

Confirmation body rules implemented client-side: `override: true` + note ≥ 10 for
pickups by unauthorized/unregistered people; `documentChecked` required for SAÍDA when the
guardian has no photo or an exception is being recorded; note required for a checkout of a
stale child; offline SAÍDA refused when the directory is older than
`config.offlineCheckoutMaxAgeHours`; `denied` events for blocked links.

## Test ids (e2e)

`login-identifier`, `login-password`, `login-submit`, `gate-code-input`, `gate-present-count`
("N na creche (+M sem saída ontem)"), `gate-search-button`, `gate-search-input`,
`gate-search-result-<ownerId>`, `confirm-screen`, `confirm-child-<childId>` (row with
`aria-checked`), `confirm-action-checkin`, `confirm-action-checkout` (`aria-pressed`),
`confirm-submit`, `confirm-offline-banner` (only when the live lookup failed), `success-screen`,
`success-undo`, `success-close`, `today-list`, `today-child-<childId>`, `history-list`,
`queue-chip` (rendered only while items are waiting: "N aguardando envio · Enviar agora"; it
disappears once the queue drains and `queue-ok` — "Tudo enviado ✓" — takes its place).
Extras: `gate-guard-name`, `undo-chip`, `confirm-person-<id>` / `confirm-person-other`,
`confirm-document-checked`, `confirm-note`, `confirm-person-name`, `confirm-denied`,
`history-event-<id>`, `switch-guard-<id>`, `password-new`, `password-confirm`.

Note for the e2e flow: when the guardian has **no photo**, SAÍDA requires the
"Documento conferido" checkbox (`confirm-document-checked`) before `confirm-submit` enables.

## Guardian app (`src/pages/guardian`)

| Page | Route | Notes |
| --- | --- | --- |
| `Inicio` | `/inicio` | One `child-card-<id>` per `GET /me/children` with the spec §7 status line (`statusText.ts`, pure: "Na creche desde 07:45 · deixado por…", "Fora da creche · saiu 17:30 com…", "Saída de ontem não registrada — fale com a secretaria", "Desligado(a) em DD/MM"); `alerts-badge` (header bell, `data-unread`) from `GET /me/notifications?limit=1`; "Autorizar alguém a buscar hoje" → `AuthorizationSheet` (child picker when several children with `myCanPickup`). |
| `Alertas` | `/alertas` | Feed with `nextBefore` paging ("Carregar mais"); marks everything read on open (`POST /me/notifications/read`) but keeps the "novo" badge for the items that were unread; `?n=<id>` keeps paging (≤ 5 pages) until the item is loaded, then scrolls/highlights it (`.alert-item--focus`); exceptions/denials red (`.alert-item--override`). Test ids `alerts-list`, `alert-item` (`data-id`, `data-kind`, `data-override`). |
| `Filho` | `/filho/:id` | Tabs Histórico (`GET /attendance/events?childId=` with offset paging and "Mostrar cancelados") and "Quem pode buscar" (guardians without photo/contact, authorizations with badges válida hoje/futura/expirada/revogada; revoke only the ones the user created). |
| `Config` | `/config` | `PushSection` (permission → `subscribePush(config.vapidPublicKey)` → "Enviar teste" / "Desativar"; iOS-not-standalone and blocked guidance), preferences (optimistic `PATCH /me/preferences`), name/phone (`PATCH /me`), `ChangePasswordSection`, logout. `PushSection` and `ChangePasswordSection` are reused by the admin settings page. |

## Admin app (`src/pages/admin`)

| Page | Route | Notes |
| --- | --- | --- |
| `Painel` | `/admin` | Every `AdminStats` field: stat cards (`stats-present`, backup red > 48 h), gate heartbeats (queue red > 10 min), e-mail/push counters, stale / absent-5-days lists, exceptions / conflicts / denied with void; `demo-banner`; auto-refresh every 60 s while visible. Stat cards link to the children list with `?f=` flags. |
| `criancas/Criancas` | `/admin/criancas` | Loads all children once (`includeInactive`) and filters client-side (`admin/childFilters.ts`: name or guardian name, turma, turno, `?f=` flag, inactive toggle). "Nova criança" → `ChildForm` → redirects to the detail's Responsáveis tab. |
| `criancas/Crianca` | `/admin/criancas/:id?tab=` | Tabs: dados (`ChildForm`: CreateChildBody + LGPD consent block, partial consent refused client-side), foto (`PhotoUpload`), responsáveis (`GuardiansTab`: reachable/access badges, edit link with block + reason, add existing via `GET /users?role=guardian&q=`, add new with `InviteSheet`, remove), autorizações (`AuthorizationsTab`, admin sees documents and full history), carteirinhas (`OwnerCredentials`), histórico (`HistoryTab` with filters, paging and void), mais (print authorized list → `AuthorizedPrint`, deactivate/reactivate, anonymize when inactive). |
| `Responsaveis`, `Responsavel` | `/admin/responsaveis[/:id]` | List with "sem contato"/"sem acesso" badges and search; create (guardian only, invite sheet); detail tabs dados (`UserEditForm`), foto, filhos, carteirinhas, acesso (invite / reset link, preferences, sessions revoke, deactivate, anonymize). `lastEmailError` only on the detail (not in `UserDTO`). |
| `Equipe` | `/admin/equipe` | Guards + admins; create (login/e-mail, password ≥ 8 / 12, PIN for guards), edit (incl. new password), set PIN, revoke sessions, deactivate/reactivate. |
| `Carteirinhas` | `/admin/carteirinhas` | All credentials (owner type, turma, NFC, revoked, search by name/code), selection → print link, bulk generation (`POST /credentials/bulk`, created ones get pre-selected). |
| `CarteirinhasImprimir` | `/admin/carteirinhas/imprimir?ids=…\|className=…&photo=1` | `admin/cards.ts` builds the model; A4 sheets of 10 CR80 cards (`.cards-page` / `.cr80`, 85.6 × 54 mm, QR 32 mm, code 15 pt, NFC circle, optional photo). Photos come from `GET /children` / `GET /users?role=guardian` (the credential DTO has none). |
| `Relatorios` | `/admin/relatorios` | Dia (date + turma, table, faltas, exceções/conflitos/recusas/cancelados with void, print), Frequência (month + turma, CSV via `apiBlob` → `saveBlob`), Exportar (from/to ≤ 366 days → `/attendance/events.csv`). |
| `Lancar` | `/admin/lancar` | Date + turma → grid (`backfill-row-<childId>`) with entrada/saída time and person dropdowns (links + authorizations valid on that date + "outra pessoa"); `admin/backfillLogic.ts` builds `BackfillBody` (`zonedToIso` in the daycare TZ, one `clientId` per event) and maps results back as `backfill-outcome-<childId>.<type>` badges; accepted rows are cleared to avoid double submits. |
| `Importar` | `/admin/importar` | Template download, file picker, dry-run preview table + summary, commit, result. |
| `Auditoria` | `/admin/auditoria` | `GET /admin/audit` with `before` paging and client-side text filter. |
| `Configuracoes` | `/admin/configuracoes` | Settings form (`DaycareSettingsBody`), test e-mail (503 `EMAIL_DISABLED` explained), VAPID status + `PushSection`, backup (run / download via `apiBlob`), admin password change (≥ 12), versions. |

Forms validate client-side with the shared zod schemas (`validateWith`) and map server
`VALIDATION` issues back onto fields (`issuesFromError`); every list has loading / error /
empty states via `QueryState`. Extra test ids: `child-card-<id>`, `alerts-badge`, `alerts-list`,
`alert-item`, `child-history`, `authorization-<id>`, `pref-checkin-push|email`, `push-enable|test`,
`stats-present`, `demo-banner`, `children-list`, `child-row-<id>`, `child-new`, `child-name`,
`child-submit`, `guardian-add-new|existing`, `guardian-search`, `guardian-result-<id>`,
`guardian-link-<id>`, `link-submit`, `link-blocked`, `credential-<id>`, `credentials-bulk|print`,
`print-card-<id>`, `daily-table`, `frequency-table`, `frequency-csv`, `events-csv`, `backfill-grid`,
`backfill-row-<id>`, `backfill-submit`, `backfill-outcome-<id>.<type>`, `import-file`,
`import-preview`, `import-commit`, `audit-table`, `test-email`, `backup-run|download`,
`staff-row-<id>`, `staff-new`, `user-invite`.
