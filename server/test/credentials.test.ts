import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_ALPHABET } from '@creche/shared';
import { ADMIN_PASSWORD, GUARD_PASSWORD, createAdmin, createChild, createGuard, createGuardian, createTestApp, del, get, link, login, post } from './helpers.js';

const validCode = (code: string) => code.length === 8 && [...code].every((c) => CODE_ALPHABET.includes(c));

test('POST /credentials generates a unique 8-char code; owner checks; nfcUid normalized', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const maria = await createGuardian(t, { email: 'maria@creche.test', name: 'Maria' });
    const child = createChild(t, { name: 'Ana', className: 'Maternal I' });
    const inactive = await createGuardian(t, { email: 'off@creche.test', active: false });

    const c1 = await post(t, '/api/credentials', { ownerType: 'guardian', ownerId: maria.id, label: 'Carteirinha 1' }, admin);
    assert.equal(c1.status, 201);
    assert.ok(validCode(c1.body.code), c1.body.code);
    assert.equal(c1.body.ownerName, 'Maria');
    assert.equal(c1.body.ownerClassName, null);
    assert.equal(c1.body.nfcUid, null);
    assert.equal(c1.body.active, true);
    assert.equal(c1.body.label, 'Carteirinha 1');

    const c2 = await post(t, '/api/credentials', { ownerType: 'child', ownerId: child.id, nfcUid: '04:A3:2B:1C:9D:80' }, admin);
    assert.equal(c2.status, 201);
    assert.equal(c2.body.nfcUid, '04a32b1c9d80');
    assert.equal(c2.body.ownerClassName, 'Maternal I');
    assert.notEqual(c1.body.code, c2.body.code);

    const dupUid = await post(t, '/api/credentials', { ownerType: 'guardian', ownerId: maria.id, nfcUid: '04a32b1c9d80' }, admin);
    assert.equal(dupUid.status, 409);
    assert.equal(dupUid.body.error.code, 'UID_IN_USE');

    const unknown = await post(t, '/api/credentials', { ownerType: 'child', ownerId: '00000000-0000-4000-8000-000000000000' }, admin);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'NOT_FOUND');
    const off = await post(t, '/api/credentials', { ownerType: 'guardian', ownerId: inactive.id }, admin);
    assert.equal(off.status, 404);
    assert.equal(off.body.error.code, 'OWNER_INACTIVE');
    const wrongType = await post(t, '/api/credentials', { ownerType: 'child', ownerId: maria.id }, admin);
    assert.equal(wrongType.status, 404);

    // Filters.
    assert.equal((await get(t, '/api/credentials', admin)).body.length, 2);
    assert.equal((await get(t, `/api/credentials?ownerType=guardian`, admin)).body.length, 1);
    assert.equal((await get(t, `/api/credentials?ownerId=${child.id}`, admin)).body.length, 1);
    assert.equal((await get(t, `/api/credentials?className=Maternal%20I`, admin)).body.length, 1, 'child of the class');
    link(t, child.id, maria.id);
    assert.equal((await get(t, `/api/credentials?className=Maternal%20I`, admin)).body.length, 2, 'guardian linked to the class too');

    // Child detail carries its active credentials.
    const detail = await get(t, `/api/children/${child.id}`, admin);
    assert.equal(detail.body.credentials.length, 1);
    assert.equal(detail.body.credentials[0].id, c2.body.id);
  } finally {
    await t.close();
  }
});

test('bind NFC (guard allowed), revoke (notifier), revoked credentials free their code/uid', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const guard = await createGuard(t, { login: 'carlos' });
    const guardToken = await login(t, 'carlos', GUARD_PASSWORD);
    const maria = await createGuardian(t, { email: 'maria@creche.test' });
    const jose = await createGuardian(t, { email: 'jose@creche.test' });
    const c1 = (await post(t, '/api/credentials', { ownerType: 'guardian', ownerId: maria.id }, admin)).body;
    const c2 = (await post(t, '/api/credentials', { ownerType: 'guardian', ownerId: jose.id }, admin)).body;

    const bound = await post(t, `/api/credentials/${c1.id}/nfc`, { uid: '04-AA-BB-CC' }, guardToken);
    assert.equal(bound.status, 200);
    assert.equal(bound.body.nfcUid, '04aabbcc');
    const clash = await post(t, `/api/credentials/${c2.id}/nfc`, { uid: '04AABBCC' }, admin);
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'UID_IN_USE');
    const rebind = await post(t, `/api/credentials/${c1.id}/nfc`, { uid: '04aabbcc' }, admin);
    assert.equal(rebind.status, 200, 'same credential may re-bind its own uid');
    const badUid = await post(t, `/api/credentials/${c1.id}/nfc`, { uid: 'zz-zz' }, admin);
    assert.equal(badUid.status, 400);

    // Guard cannot revoke; admin can. Revocation notifies the owner.
    assert.equal((await del(t, `/api/credentials/${c1.id}`, guardToken)).status, 403);
    const version = (await get(t, '/api/config')).body.directoryVersion;
    const revoked = await del(t, `/api/credentials/${c1.id}`, admin);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.active, false);
    assert.ok(revoked.body.revokedAt);
    assert.equal(revoked.body.code, c1.code, 'code is kept on the revoked row');
    assert.deepEqual(t.notifier.calls.map((c) => c.method), ['credentialRevoked']);
    assert.equal(t.notifier.calls[0].args[0], c1.id);
    assert.equal((await get(t, '/api/config')).body.directoryVersion, version + 1);

    // Revoking again is idempotent (no second notification); revoked cards cannot bind NFC.
    assert.equal((await del(t, `/api/credentials/${c1.id}`, admin)).status, 200);
    assert.equal(t.notifier.calls.length, 1);
    const onRevoked = await post(t, `/api/credentials/${c1.id}/nfc`, { uid: '04aabbcc' }, admin);
    assert.equal(onRevoked.status, 404);
    assert.equal(onRevoked.body.error.code, 'CARD_REVOKED');

    // The uid is free again for another active card.
    assert.equal((await post(t, `/api/credentials/${c2.id}/nfc`, { uid: '04aabbcc' }, admin)).status, 200);
    assert.equal((await get(t, '/api/credentials', admin)).body.length, 1);
    assert.equal((await get(t, '/api/credentials?includeRevoked=true', admin)).body.length, 2);
    assert.equal((await del(t, '/api/credentials/00000000-0000-4000-8000-000000000000', admin)).status, 404);
    void guard;
  } finally {
    await t.close();
  }
});

test('POST /credentials/bulk: only owners of a class without an active card', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const a = createChild(t, { name: 'A', className: 'Berçário' });
    const b = createChild(t, { name: 'B', className: 'Berçário' });
    createChild(t, { name: 'C', className: 'Maternal I' });
    createChild(t, { name: 'D', className: 'Berçário', active: false });
    const g1 = await createGuardian(t, { email: 'g1@creche.test' });
    const g2 = await createGuardian(t, { email: 'g2@creche.test' });
    await createGuardian(t, { email: 'g3@creche.test' });
    link(t, a.id, g1.id);
    link(t, b.id, g2.id);
    assert.equal((await post(t, '/api/credentials', { ownerType: 'child', ownerId: a.id }, admin)).status, 201);

    const children = await post(t, '/api/credentials/bulk', { ownerType: 'child', className: 'Berçário' }, admin);
    assert.equal(children.status, 201);
    assert.deepEqual(children.body.created.map((c: { ownerName: string }) => c.ownerName), ['B']);

    const guardians = await post(t, '/api/credentials/bulk', { ownerType: 'guardian', className: 'Berçário' }, admin);
    assert.equal(guardians.body.created.length, 2);
    const again = await post(t, '/api/credentials/bulk', { ownerType: 'guardian', className: 'Berçário' }, admin);
    assert.equal(again.body.created.length, 0);

    const everyone = await post(t, '/api/credentials/bulk', { ownerType: 'child', onlyWithout: false }, admin);
    assert.equal(everyone.body.created.length, 3, 'all active children, even those with a card');
    const codes = new Set((await get(t, '/api/credentials', admin)).body.map((c: { code: string }) => c.code));
    assert.equal(codes.size, 7, '1 + 1 + 2 + 3 cards, all distinct');
  } finally {
    await t.close();
  }
});
