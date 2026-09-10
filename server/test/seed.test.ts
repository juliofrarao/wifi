import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_ADMIN, DEMO_GUARD_PASSWORD, SEED_PREFIX, SeedRefused, cleanSeed, hasRealData, runSeed, seedId } from '../src/seed.js';
import { detectImage } from '../src/lib/photos.js';
import { createChild, createTestApp, get, login, post } from './helpers.js';

test('seed: deterministic demo data on an empty database, refuses real data without --force, --clean removes only demo rows', async () => {
  const t = await createTestApp();
  try {
    assert.equal(seedId('user:maria'), seedId('user:maria'));
    assert.match(seedId('x'), /^d3a0d3a0-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(hasRealData(t.db), false);

    // Thursday 2026-09-10 09:00 São Paulo.
    const summary = await runSeed(t.db, t.config, { now: t.clock.now() });
    assert.equal(summary.users, 23);
    assert.equal(summary.children, 12);
    assert.equal(summary.credentials, 33);
    assert.ok(summary.events > 80);
    assert.ok(summary.notifications > 100);
    assert.equal(summary.photos, 29);
    const files = fs.readdirSync(path.join(t.config.dataDir, 'uploads'));
    assert.equal(files.length, 29);
    assert.equal(detectImage(fs.readFileSync(path.join(t.config.dataDir, 'uploads', files[0])))?.mime, 'image/png');

    // Logins per spec §12.
    const admin = await login(t, DEMO_ADMIN.email, DEMO_ADMIN.password);
    const carlos = await login(t, 'carlos', DEMO_GUARD_PASSWORD);
    const maria = await login(t, 'maria@demo.local', 'demo-maria-123');
    const guards = await get(t, '/api/auth/guards', carlos);
    assert.deepEqual(guards.body.map((g: { name: string }) => g.name).sort(), ['Ana Ribeiro', 'Carlos Mendes']);
    const anaGuard = (t.db.prepare(`SELECT id FROM users WHERE login = 'ana'`).get() as { id: string }).id;
    // Quick switch by PIN ends the current session, so use a separate one for it.
    assert.equal((await post(t, '/api/auth/switch', { userId: anaGuard, pin: '5678' }, await login(t, 'carlos', DEMO_GUARD_PASSWORD))).status, 200);

    // Maria's card AAAA-2222 → her two children (sibling pair); the old card is revoked.
    const lookup = await post(t, '/api/scan/lookup', { code: 'AAAA-2222' }, carlos);
    assert.equal(lookup.status, 200, JSON.stringify(lookup.body));
    assert.equal(lookup.body.guardian.name, 'Maria Silva');
    assert.deepEqual(lookup.body.children.map((c: { name: string }) => c.name).sort(), ['Ana Souza', 'Pedro Souza']);
    assert.match(lookup.body.guardian.photoUrl, /^\/api\/files\//);
    assert.equal((await post(t, '/api/scan/lookup', { code: 'AAAA-9999' }, carlos)).body.error.code, 'CARD_REVOKED');
    assert.equal((await post(t, '/api/scan/lookup', { uid: '04:A2:24:C2:D6:1E:80' }, carlos)).body.guardian.name, 'Maria Silva');
    const mine = await get(t, '/api/me/children', maria);
    assert.equal(mine.body.length, 2);
    assert.ok(mine.body.every((c: { status: { present: boolean; lastEvent: { type: string } } }) => !c.status.present && c.status.lastEvent.type === 'checkout'), 'not arrived yet today (e2e starts with their ENTRADA)');
    assert.ok(mine.body.some((c: { authorizedPersons: unknown[] }) => c.authorizedPersons.length === 1), 'neighbour authorized today');
    const feed = await get(t, '/api/me/notifications', maria);
    assert.ok(feed.body.items.length >= 5, 'delivered alerts in the feed');

    // Dashboard: demo banner, stale child, exceptions, refusals, conflicts, absences.
    const stats = await get(t, '/api/admin/stats', admin);
    assert.equal(stats.body.demoData, true);
    assert.equal(stats.body.childrenActive, 12);
    assert.equal(stats.body.guardiansActive, 20);
    assert.equal(stats.body.stalePresentCount, 1);
    assert.equal(stats.body.staleChildren[0].name, 'Gabriel Santos');
    assert.equal(stats.body.presentNow, 7, '12 − Isabela, Sofia, Gabriel (stale), Ana and Pedro (not yet)');
    assert.equal(stats.body.recentOverrides.length, 1);
    assert.equal(stats.body.recentDenied.length, 1);
    assert.equal(stats.body.recentConflicts.length, 1);
    assert.deepEqual(stats.body.childrenAbsent5Days.map((c: { name: string }) => c.name), ['Isabela Martins']);
    assert.equal(stats.body.childrenWithoutConsent, 2);
    assert.equal((await get(t, '/api/config')).body.demoData, true);
    const children = await get(t, '/api/children', admin);
    const byName = (n: string) => children.body.find((c: { name: string }) => c.name === n);
    assert.equal(byName('Sofia Pereira').photoUrl, null, 'one child without photo');
    assert.equal(byName('Davi Ferreira').guardians.find((g: { name: string }) => g.name === 'Paulo Ferreira').blocked, true);
    assert.equal(byName('Laura Almeida').guardians.find((g: { name: string }) => g.name === 'Marcos Almeida').canPickup, false);
    assert.equal(byName('Miguel Costa').guardians.find((g: { name: string }) => g.name === 'Renata Costa').pickupAllowedNow, false, 'expired link');
    const daily = await get(t, '/api/reports/daily', admin);
    assert.equal(daily.body.absent.length, 5, 'Sofia, Gabriel, Isabela, Ana, Pedro (so far today)');

    // Re-running replaces the demo data (idempotent).
    const again = await runSeed(t.db, t.config, { now: t.clock.now() });
    assert.ok(again.cleaned > 0);
    assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM children').get() as { n: number }).n, 12);
    assert.equal(fs.readdirSync(path.join(t.config.dataDir, 'uploads')).length, 29);

    // Real data → refused without force; force keeps the real child.
    const real = createChild(t, { name: 'Criança Real' });
    assert.equal(hasRealData(t.db), true);
    await assert.rejects(runSeed(t.db, t.config, { now: t.clock.now() }), SeedRefused);
    await runSeed(t.db, t.config, { now: t.clock.now(), force: true });
    assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM children').get() as { n: number }).n, 13);

    // --clean removes the demo rows and files only.
    const removed = cleanSeed(t.db, t.config);
    assert.ok(removed > 0);
    assert.equal((t.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE id LIKE '${SEED_PREFIX}%'`).get() as { n: number }).n, 0);
    assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM children').get() as { n: number }).n, 1);
    assert.equal((t.db.prepare('SELECT * FROM children').get() as { id: string }).id, real.id);
    for (const table of ['attendance_events', 'notifications', 'credentials', 'child_guardians', 'pickup_authorizations', 'files']) {
      assert.equal((t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
    }
    assert.equal(fs.readdirSync(path.join(t.config.dataDir, 'uploads')).length, 0);
    assert.equal((await get(t, '/api/config')).body.demoData, false);
  } finally {
    await t.close();
  }
});
