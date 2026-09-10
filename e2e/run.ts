/**
 * End-to-end scenario of spec §13 — `npm run test:e2e` (node --import tsx e2e/run.ts).
 *
 * 1. Wipes the temporary DATA_DIR, seeds the demo data and starts the built
 *    server (server/dist) serving the built PWA (web/dist) on a free port with
 *    NOTIFY_HOLD_SECONDS=2 and no SMTP.
 * 2. Drives Chromium (Playwright, 412×915 mobile viewport):
 *    guard `carlos` types Maria's code AAAA-2222 → ENTRADA of both children →
 *    undo → ENTRADA again while OFFLINE (resolved from the cached directory,
 *    queued, drained when the connection returns) → SAÍDA;
 *    guardian Maria sees both children "Fora da creche · saiu…" and the
 *    checkout alert; the admin sees the children in the daily report.
 * 3. Asserts through the API that the in-app rows were `sent` after the hold
 *    window and that the e-mail rows were `skipped` (`email_disabled`).
 *
 * Exit code 0 on success, 1 on failure. Screenshots of every open page are
 * written to e2e/output/ when a step fails; the server log is e2e/output/server.log.
 * Set E2E_DATA_DIR to relocate the temporary data directory and
 * PLAYWRIGHT_CHROMIUM_PATH to point at a Chromium binary when Playwright's own
 * download is missing.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdminNotificationRow, AuthResult, ChildAdminDTO } from '@creche/shared';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = path.join(ROOT, 'e2e', 'output');
const DATA_DIR = process.env.E2E_DATA_DIR ? path.resolve(process.env.E2E_DATA_DIR) : path.join(OUTPUT_DIR, 'data');
const SERVER_LOG = path.join(OUTPUT_DIR, 'server.log');
const SERVER_ENTRY = path.join(ROOT, 'server', 'dist', 'index.js');
const SEED_ENTRY = path.join(ROOT, 'server', 'dist', 'seed.js');
const WEB_DIST = path.join(ROOT, 'web', 'dist');
const TZ = 'America/Sao_Paulo';
const HOLD_SECONDS = 2;
const STEP_TIMEOUT = 30_000;
const TOTAL_TIMEOUT = 8 * 60 * 1000;

/** Seed data (server/src/seed.ts): guardianCode(0) = AAAA2222 belongs to Maria Silva. */
const MARIA_CODE = 'AAAA2222';
const GUARD = { login: 'carlos', password: 'demo-guard-123', name: 'Carlos Mendes' };
const MARIA = { email: 'maria@demo.local', password: 'demo-maria-123', name: 'Maria Silva' };
const JOAO_NAME = 'João Souza';
const ADMIN = { email: 'admin@demo.local', password: 'demo-admin-123' };
const CHILDREN = ['Ana Souza', 'Pedro Souza'];

// ---------------------------------------------------------------------------
// Logging, steps, screenshots
// ---------------------------------------------------------------------------

const startedAt = Date.now();
function log(message: string): void {
  const t = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  console.log(`[e2e ${t}s] ${message}`);
}

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

const openPages: { name: string; page: Page }[] = [];
let runningServer: { stop: () => Promise<void> } | null = null;

async function screenshotAll(prefix: string): Promise<void> {
  for (const { name, page } of openPages) {
    if (page.isClosed()) continue;
    const file = path.join(OUTPUT_DIR, `${prefix}-${name}.png`);
    try {
      await page.screenshot({ path: file, fullPage: true });
      log(`  captura salva em ${path.relative(ROOT, file)}`);
    } catch (err) {
      log(`  não foi possível capturar ${name}: ${String(err)}`);
    }
  }
}

let stepNo = 0;
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  stepNo++;
  const n = String(stepNo).padStart(2, '0');
  log(`▶ ${n}. ${name}`);
  const t0 = Date.now();
  try {
    const out = await fn();
    log(`  ✔ ${name} (${Date.now() - t0} ms)`);
    return out;
  } catch (err) {
    log(`  ✘ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    await screenshotAll(`${n}-${slug(name)}`);
    throw err;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `probe` until it returns a truthy value. */
async function waitUntil<T>(label: string, probe: () => Promise<T | null | undefined | false>, timeout = STEP_TIMEOUT, interval = 250): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`tempo esgotado esperando: ${label}${lastError ? ` (último erro: ${lastError instanceof Error ? lastError.message : String(lastError)})` : ''}`);
    }
    await sleep(interval);
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address() as net.AddressInfo;
      srv.close(() => resolve(address.port));
    });
  });
}

function serverEnv(port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATA_DIR,
    WEB_DIST,
    APP_URL: `http://127.0.0.1:${port}`,
    PORT: String(port),
    HOST: '127.0.0.1',
    TZ,
    NOTIFY_HOLD_SECONDS: String(HOLD_SECONDS),
    // No e-mail: the rows must end up `skipped` (email_disabled).
    SMTP_HOST: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    // The seed creates the demo admin; never let a local .env inject ADMIN_*.
    ADMIN_EMAIL: '',
    ADMIN_PASSWORD: '',
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    TRUST_PROXY: 'false',
    LOG_LEVEL: 'info',
  };
}

function ensureBuilt(): void {
  const missing = [SERVER_ENTRY, SEED_ENTRY, path.join(WEB_DIST, 'index.html')].filter((f) => !fs.existsSync(f));
  if (missing.length === 0) return;
  log(`artefatos ausentes (${missing.map((m) => path.relative(ROOT, m)).join(', ')}): executando npm run build`);
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error('npm run build falhou');
}

function seed(port: number): void {
  const r = spawnSync(process.execPath, [SEED_ENTRY], { cwd: ROOT, env: serverEnv(port), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`seed falhou (status ${r.status}):\n${r.stdout}\n${r.stderr}`);
  const first = r.stdout.split('\n').find((l) => l.trim()) ?? '';
  log(`seed: ${first.trim()}`);
  const summary = r.stdout.split('\n').find((l) => l.startsWith('Usuários'));
  if (summary) log(`seed: ${summary.trim()}`);
}

interface RunningServer {
  child: ChildProcess;
  baseUrl: string;
  exited: () => boolean;
  tail: () => string;
  stop: () => Promise<void>;
}

async function startServer(port: number): Promise<RunningServer> {
  const logStream = fs.createWriteStream(SERVER_LOG, { flags: 'a' });
  const recent: string[] = [];
  const child = spawn(process.execPath, [SERVER_ENTRY], { cwd: ROOT, env: serverEnv(port), stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    logStream.write(text);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      recent.push(line);
      if (recent.length > 60) recent.shift();
    }
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  let exited = false;
  let exitCode: number | null = null;
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
    logStream.end();
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitUntil(
    `servidor respondendo em ${baseUrl}/api/config`,
    async () => {
      if (exited) throw new Error(`o servidor encerrou com código ${exitCode}:\n${recent.join('\n')}`);
      const res = await fetch(`${baseUrl}/api/config`);
      return res.ok;
    },
    STEP_TIMEOUT
  );
  const stop = async () => {
    if (exited) return;
    child.kill('SIGTERM');
    const deadline = Date.now() + 5000;
    while (!exited && Date.now() < deadline) await sleep(100);
    if (!exited) {
      child.kill('SIGKILL');
      while (!exited) await sleep(50);
    }
  };
  return { child, baseUrl, exited: () => exited, tail: () => recent.join('\n'), stop };
}

// ---------------------------------------------------------------------------
// API helpers (Node side)
// ---------------------------------------------------------------------------

async function api<T>(baseUrl: string, route: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}/api${route}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.method ?? 'GET'} ${route} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function apiLogin(baseUrl: string, identifier: string, password: string): Promise<string> {
  const r = await api<AuthResult>(baseUrl, '/auth/login', { method: 'POST', body: { identifier, password } });
  return r.token;
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (err) {
    const exe = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
    log(`chromium.launch() falhou (${(err instanceof Error ? err.message : String(err)).split('\n')[0]}); tentando executablePath=${exe}`);
    return chromium.launch({ executablePath: exe });
  }
}

async function newMobileContext(browser: Browser, baseURL: string, name: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'pt-BR',
    timezoneId: TZ,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => log(`  [${name}] erro na página: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') log(`  [${name}] console.error: ${m.text()}`);
  });
  openPages.push({ name, page });
  return { context, page };
}

const byTestId = (page: Page, id: string): Locator => page.getByTestId(id);

async function visible(page: Page, id: string, timeout = STEP_TIMEOUT): Promise<Locator> {
  const l = byTestId(page, id).first();
  await l.waitFor({ state: 'visible', timeout });
  return l;
}

async function hidden(page: Page, id: string, timeout = STEP_TIMEOUT): Promise<void> {
  await byTestId(page, id).first().waitFor({ state: 'hidden', timeout });
}

async function login(page: Page, identifier: string, password: string, expectedPath: string): Promise<void> {
  await page.goto('/login');
  await (await visible(page, 'login-identifier')).fill(identifier);
  await byTestId(page, 'login-password').fill(password);
  await byTestId(page, 'login-submit').click();
  await page.waitForURL((u) => u.pathname === expectedPath, { timeout: STEP_TIMEOUT });
}

/** Types a card code on the Leitura screen (auto-submits at 8 valid chars) and waits for the confirmation. */
async function typeCode(page: Page, code: string): Promise<Locator> {
  const input = await visible(page, 'gate-code-input');
  await input.fill('');
  await input.fill(code);
  return visible(page, 'confirm-screen');
}

async function presentCount(page: Page): Promise<number> {
  const text = (await byTestId(page, 'gate-present-count').innerText()).trim();
  const m = text.match(/^(\d+)/);
  if (!m) throw new Error(`contador ilegível: "${text}"`);
  return Number(m[1]);
}

async function expectChildRows(page: Page, ids: string[], expected: { checked: boolean; statusPattern: RegExp }): Promise<void> {
  for (const id of ids) {
    const row = await visible(page, `confirm-child-${id}`);
    const checked = await row.getAttribute('aria-checked');
    assert.equal(checked, String(expected.checked), `confirm-child-${id}: aria-checked=${checked}`);
    const text = await row.innerText();
    assert.match(text, expected.statusPattern, `confirm-child-${id}: "${text.replace(/\s+/g, ' ')}"`);
  }
}

async function expectPressed(page: Page, id: string): Promise<void> {
  await waitUntil(`${id} aria-pressed=true`, async () => (await byTestId(page, id).getAttribute('aria-pressed')) === 'true', 5000);
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUTPUT_DIR)) {
    if (f.endsWith('.png') || f === 'server.log') fs.rmSync(path.join(OUTPUT_DIR, f), { force: true });
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  log(`DATA_DIR temporário: ${DATA_DIR}`);

  ensureBuilt();
  const port = await freePort();
  seed(port);
  const server = await startServer(port);
  runningServer = server;
  const baseUrl = server.baseUrl;
  log(`servidor no ar em ${baseUrl} (NOTIFY_HOLD_SECONDS=${HOLD_SECONDS}, SMTP desligado)`);
  const scenarioStart = new Date().toISOString();

  let browser: Browser | null = null;
  try {
    // ---- Reference data through the API -------------------------------------------------
    const adminToken = await apiLogin(baseUrl, ADMIN.email, ADMIN.password);
    const children = await api<ChildAdminDTO[]>(baseUrl, '/children', { token: adminToken });
    const childIds = CHILDREN.map((name) => {
      const c = children.find((x) => x.name === name);
      if (!c) throw new Error(`criança "${name}" não encontrada no seed`);
      return c.id;
    });
    const [anaId, pedroId] = childIds;
    log(`crianças de Maria: Ana=${anaId} Pedro=${pedroId}`);
    for (const c of children.filter((x) => childIds.includes(x.id))) {
      assert.equal(c.status.present, false, `${c.name} deveria começar fora da creche`);
    }

    browser = await launchBrowser();
    log(`chromium ${browser.version()}`);

    // ---- Guard --------------------------------------------------------------------------
    const guard = await newMobileContext(browser, baseUrl, 'portaria');
    const gp = guard.page;

    await step(`Login da vigilante (${GUARD.login}) → /portaria`, async () => {
      await login(gp, GUARD.login, GUARD.password, '/portaria');
      const name = await visible(gp, 'gate-guard-name');
      assert.match(await name.innerText(), new RegExp(GUARD.name));
    });

    const initialPresent = await step('Leitura com diretório baixado', async () => {
      await visible(gp, 'gate-code-input');
      await gp.getByText(/Diretório: atualizado/).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      await visible(gp, 'queue-ok');
      const n = await presentCount(gp);
      log(`  ${n} na creche antes do cenário`);
      return n;
    });

    await step('Digitar AAAA-2222 → confirmação mostra Ana e Pedro, ENTRADA sugerida', async () => {
      await typeCode(gp, MARIA_CODE);
      await expectPressed(gp, 'confirm-action-checkin');
      await expectChildRows(gp, childIds, { checked: true, statusPattern: /Fora/ });
      const label = await byTestId(gp, 'confirm-submit').innerText();
      assert.match(label, /ENTRADA/, `botão: ${label}`);
      assert.match(label, /\(2\)/, `botão deve nomear as duas crianças: ${label}`);
    });

    await step('Registrar ENTRADA → tela de sucesso', async () => {
      await byTestId(gp, 'confirm-submit').click();
      const success = await visible(gp, 'success-screen');
      assert.match(await success.innerText(), /ENTRADA registrada/);
      await waitUntil('contador sobe para +2', async () => (await presentCount(gp)) === initialPresent + 2, 5000);
    });

    await step('Desfazer dentro da janela', async () => {
      // The success screen closes by itself after 3 s; fall back to the "Desfazer último registro" chip.
      try {
        await byTestId(gp, 'success-undo').click({ timeout: 2500 });
      } catch {
        log('  tela de sucesso já fechou; usando o chip de desfazer');
        await byTestId(gp, 'undo-chip').click({ timeout: 5000 });
      }
      await gp.getByText(/Registro desfeito/).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
      await hidden(gp, 'success-screen');
    });

    await step('As duas crianças voltam a "fora"', async () => {
      await waitUntil(`contador volta a ${initialPresent}`, async () => (await presentCount(gp)) === initialPresent, 10_000);
      const events = await api<{ items: { type: string; voidedAt: string | null; childId: string }[] }>(baseUrl, `/attendance/events?childId=${anaId}&includeVoided=true&limit=5`, { token: adminToken });
      const last = events.items[0];
      assert.ok(last && last.type === 'checkin' && last.voidedAt, 'a última entrada de Ana deve estar cancelada no servidor');
    });

    await step('OFFLINE: o código ainda resolve pelo diretório em cache', async () => {
      await guard.context.setOffline(true);
      await typeCode(gp, MARIA_CODE);
      await expectPressed(gp, 'confirm-action-checkin');
      await expectChildRows(gp, childIds, { checked: true, statusPattern: /Fora/ });
    });

    await step('ENTRADA offline → registro fica na fila', async () => {
      await byTestId(gp, 'confirm-submit').click();
      const success = await visible(gp, 'success-screen');
      assert.match(await success.innerText(), /ENTRADA registrada/);
      const chip = await visible(gp, 'queue-chip');
      assert.match(await chip.innerText(), /1 aguardando envio/);
      await byTestId(gp, 'success-close').click();
      await hidden(gp, 'success-screen');
    });

    await step('Conexão volta → a fila esvazia', async () => {
      await guard.context.setOffline(false);
      await hidden(gp, 'queue-chip', 45_000);
      await visible(gp, 'queue-ok');
      await waitUntil('servidor registrou a entrada dos dois', async () => {
        const rows = await api<ChildAdminDTO[]>(baseUrl, '/children', { token: adminToken });
        return childIds.every((id) => rows.find((c) => c.id === id)?.status.present === true);
      });
    });

    await step('Digitar o código de novo → SAÍDA sugerida → registrar', async () => {
      await typeCode(gp, MARIA_CODE);
      try {
        await expectPressed(gp, 'confirm-action-checkout');
      } catch {
        log('  SAÍDA não veio pré-selecionada; selecionando');
        await byTestId(gp, 'confirm-action-checkout').click();
        await expectPressed(gp, 'confirm-action-checkout');
      }
      await expectChildRows(gp, childIds, { checked: true, statusPattern: /Na creche desde/ });
      const submit = byTestId(gp, 'confirm-submit');
      await waitUntil('botão de SAÍDA habilitado após a verificação ao vivo', async () => (await submit.isEnabled()) && /SAÍDA/.test(await submit.innerText()), 10_000);
      await submit.click();
      const success = await visible(gp, 'success-screen');
      assert.match(await success.innerText(), /SAÍDA registrada/);
      await byTestId(gp, 'success-close').click();
      await hidden(gp, 'success-screen');
      await visible(gp, 'queue-ok');
    });

    // ---- Notifications through the API ---------------------------------------------------
    const checkoutRows = await step(`Após a janela de ${HOLD_SECONDS} s: alertas no app marcados como enviados`, async () => {
      const rows = await waitUntil(
        'linhas inapp/checkout com status sent para Maria e João',
        async () => {
          const list = await api<AdminNotificationRow[]>(baseUrl, '/admin/notifications?status=sent&limit=300', { token: adminToken });
          const mine = list.filter((r) => r.kind === 'checkout' && r.channel === 'inapp' && r.createdAt >= scenarioStart);
          const names = new Set(mine.map((r) => r.userName));
          return names.has(MARIA.name) && names.has(JOAO_NAME) ? mine : null;
        },
        HOLD_SECONDS * 1000 + 30_000,
        500
      );
      log(`  ${rows.length} alertas inapp de saída enviados: ${rows.map((r) => r.userName).join(', ')}`);
      return rows;
    });

    await step('E-mails ficaram "skipped" (SMTP desligado)', async () => {
      const skipped = await waitUntil(
        'linhas email/checkout skipped',
        async () => {
          const list = await api<AdminNotificationRow[]>(baseUrl, '/admin/notifications?status=skipped&limit=300', { token: adminToken });
          const mine = list.filter((r) => r.kind === 'checkout' && r.channel === 'email' && r.createdAt >= scenarioStart);
          return mine.some((r) => r.userName === MARIA.name) ? mine : null;
        },
        15_000,
        500
      );
      for (const r of skipped) assert.equal(r.error, 'email_disabled', `e-mail de ${r.userName}: error=${r.error}`);
      const sent = await api<AdminNotificationRow[]>(baseUrl, '/admin/notifications?status=sent&limit=300', { token: adminToken });
      assert.equal(
        sent.filter((r) => r.channel === 'email' && r.createdAt >= scenarioStart).length,
        0,
        'nenhum e-mail pode constar como enviado sem SMTP'
      );
      assert.ok(!checkoutRows.some((r) => r.channel === 'email'));
      log(`  ${skipped.length} e-mails de saída ignorados (email_disabled): ${skipped.map((r) => r.userName).join(', ')}`);
    });

    // ---- Guardian ----------------------------------------------------------------------
    const guardian = await newMobileContext(browser, baseUrl, 'responsavel');
    const mp = guardian.page;

    await step('Login de Maria → /inicio', async () => {
      await login(mp, MARIA.email, MARIA.password, '/inicio');
    });

    await step('Cards dos filhos: "Fora da creche · saiu … com Maria Silva (mãe)"', async () => {
      for (const [i, id] of childIds.entries()) {
        const card = await visible(mp, `child-card-${id}`);
        const text = (await card.innerText()).replace(/\s+/g, ' ');
        assert.match(text, new RegExp(CHILDREN[i]), text);
        assert.match(text, /Fora da creche/, text);
        assert.match(text, /saiu \d{2}:\d{2}/, text);
        assert.match(text, /Maria Silva \(mãe\)/, text);
        assert.equal(await card.getAttribute('data-status'), 'out');
      }
    });

    await step('/alertas mostra o alerta de saída', async () => {
      await mp.goto('/alertas');
      await visible(mp, 'alerts-list');
      const checkoutItems = mp.locator('[data-testid="alert-item"][data-kind="checkout"]');
      await waitUntil('alerta de saída na lista', async () => (await checkoutItems.count()) > 0);
      const checkout = checkoutItems.first();
      const text = (await checkout.innerText()).replace(/\s+/g, ' ');
      assert.match(text, /Saída registrada/, text);
      // One alert per batch: both siblings are named (templates use the snapshot child_name as stored).
      assert.match(text, /Ana Souza e Pedro Souza|Pedro Souza e Ana Souza/, text);
      assert.match(text, /saíram da creche às \d{2}:\d{2}/, text);
      assert.match(text, /Maria Silva \(mãe\)/, text);
      assert.match(text, /Carlos Mendes \(portaria\)/, text);
      const first = mp.locator('[data-testid="alert-item"]').first();
      assert.equal(await first.getAttribute('data-kind'), 'checkout', 'o alerta mais recente deve ser a saída');
      log(`  alerta: ${text.slice(0, 140)}…`);
    });

    // ---- Admin ---------------------------------------------------------------------------
    const admin = await newMobileContext(browser, baseUrl, 'admin');
    const ap = admin.page;

    await step('Login da administração → /admin', async () => {
      await login(ap, ADMIN.email, ADMIN.password, '/admin');
      await visible(ap, 'demo-banner');
    });

    await step('/admin/relatorios: relatório do dia traz Ana e Pedro com entrada e saída', async () => {
      await ap.goto('/admin/relatorios');
      await visible(ap, 'daily-table');
      for (const [i, id] of childIds.entries()) {
        const row = await visible(ap, `daily-row-${id}`);
        const cells = await row.locator('td').allInnerTexts();
        assert.match(cells[0] ?? '', new RegExp(CHILDREN[i]));
        assert.match(cells[2] ?? '', /\d{2}:\d{2}/, `entrada de ${CHILDREN[i]}: "${cells[2]}"`);
        assert.match(cells[3] ?? '', /Maria Silva/, `quem deixou ${CHILDREN[i]}: "${cells[3]}"`);
        assert.match(cells[4] ?? '', /\d{2}:\d{2}/, `saída de ${CHILDREN[i]}: "${cells[4]}"`);
        assert.doesNotMatch(cells[4] ?? '', /sem saída/);
        assert.match(cells[5] ?? '', /Maria Silva/, `quem retirou ${CHILDREN[i]}: "${cells[5]}"`);
      }
    });

    await step('API: relatório do dia e histórico coerentes', async () => {
      const report = await api<{ rows: { child: { id: string }; checkin: unknown; checkout: unknown; pending: boolean }[] }>(baseUrl, '/reports/daily', { token: adminToken });
      for (const id of childIds) {
        const row = report.rows.find((r) => r.child.id === id);
        assert.ok(row && row.checkin && row.checkout && !row.pending, `linha de ${id} no relatório`);
      }
      const events = await api<{ items: { type: string; queued: boolean; voidedAt: string | null }[] }>(baseUrl, `/attendance/events?childId=${anaId}&includeVoided=true&limit=10`, { token: adminToken });
      const today = events.items.filter((e) => !e.voidedAt).slice(0, 2).map((e) => e.type);
      assert.deepEqual(today, ['checkout', 'checkin'], `eventos de hoje de Ana: ${JSON.stringify(events.items.map((e) => [e.type, e.queued, !!e.voidedAt]))}`);
      assert.ok(events.items.some((e) => e.type === 'checkin' && e.queued && !e.voidedAt), 'a entrada feita offline deve constar como vinda da fila');
    });

    log('CENÁRIO COMPLETO ✔');
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await server.stop();
    log(`servidor encerrado; log em ${path.relative(ROOT, SERVER_LOG)}`);
  }
}

const watchdog = setTimeout(() => {
  console.error(`[e2e] tempo total excedido (${TOTAL_TIMEOUT / 1000} s)`);
  void shutdownAndExit(1);
}, TOTAL_TIMEOUT);
watchdog.unref();

/** Never leave the server child running: on Ctrl+C / kill, stop it before exiting. */
async function shutdownAndExit(code: number): Promise<void> {
  try {
    await runningServer?.stop();
  } finally {
    process.exit(code);
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.error(`\n[e2e] ${signal} recebido; encerrando o servidor`);
    void shutdownAndExit(130);
  });
}

main()
  .then(() => {
    clearTimeout(watchdog);
    process.exit(0);
  })
  .catch((err) => {
    clearTimeout(watchdog);
    console.error(`\n[e2e] FALHA: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    try {
      const tail = fs.readFileSync(SERVER_LOG, 'utf8').split('\n').filter(Boolean).slice(-25).join('\n');
      if (tail) console.error(`\n[e2e] últimas linhas do servidor:\n${tail}`);
    } catch {
      /* no log */
    }
    process.exit(1);
  });
