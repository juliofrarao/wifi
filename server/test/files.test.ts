import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ADMIN_PASSWORD, GUARD_PASSWORD, createAdmin, createChild, createGuard, createTestApp, fakeJpeg, fakePng, get, login, multipart, request } from './helpers.js';

test('photo upload + signed URL: valid signature serves the file with the spec headers; invalid → 404', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const child = createChild(t, { name: 'Ana' });

    const jpeg = fakeJpeg(1024);
    const form = multipart([{ name: 'photo', data: jpeg, filename: 'ana.jpg', contentType: 'image/jpeg' }]);
    const up = await request(t, { method: 'POST', url: `/api/children/${child.id}/photo`, payload: form.payload, headers: form.headers, token: admin });
    assert.equal(up.status, 200);
    const url = up.body.photoUrl as string;
    assert.match(url, /^\/api\/files\/[0-9a-f-]{36}\?t=[A-Za-z0-9_-]{32}$/);

    const ok = await get(t, url);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'image/jpeg');
    assert.equal(ok.headers['cache-control'], 'private, max-age=86400');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.equal(ok.headers['content-disposition'], 'inline');
    assert.equal(ok.headers['content-security-policy'], 'sandbox');
    assert.ok(ok.headers.etag);
    assert.equal(ok.raw.length, jpeg.length);
    assert.ok(ok.raw.equals(jpeg));

    const notModified = await request(t, { method: 'GET', url, headers: { 'if-none-match': String(ok.headers.etag) } });
    assert.equal(notModified.status, 304);

    const [base, sig] = url.split('?t=');
    const tampered = await get(t, `${base}?t=${sig.slice(0, -1)}${sig.endsWith('a') ? 'b' : 'a'}`);
    assert.equal(tampered.status, 404);
    assert.equal((await get(t, base)).status, 404);
    const otherId = `${base.replace(/[0-9a-f-]{36}$/, '11111111-1111-4111-8111-111111111111')}?t=${sig}`;
    assert.equal((await get(t, otherId)).status, 404);

    // The child projection carries the same URL; the file exists on disk under DATA_DIR/uploads.
    const detail = await get(t, `/api/children/${child.id}`, admin);
    assert.equal(detail.body.photoUrl, url);
    const files = fs.readdirSync(path.join(t.config.dataDir, 'uploads'));
    assert.equal(files.length, 1);
    assert.match(files[0], /\.jpg$/);

    // Replacing the photo deletes the previous file (PNG accepted).
    const form2 = multipart([{ name: 'photo', data: fakePng(), filename: 'ana.png', contentType: 'image/png' }]);
    const up2 = await request(t, { method: 'POST', url: `/api/children/${child.id}/photo`, payload: form2.payload, headers: form2.headers, token: admin });
    assert.equal(up2.status, 200);
    assert.notEqual(up2.body.photoUrl, url);
    const files2 = fs.readdirSync(path.join(t.config.dataDir, 'uploads'));
    assert.equal(files2.length, 1);
    assert.match(files2[0], /\.png$/);
    assert.equal((await get(t, url)).status, 404, 'old signed URL no longer resolves');
    assert.equal((await get(t, up2.body.photoUrl)).headers['content-type'], 'image/png');
  } finally {
    await t.close();
  }
});

test('photo upload rejects non-images (415), oversized files (413), wrong field, non-admin', async () => {
  const t = await createTestApp();
  try {
    await createAdmin(t, { email: 'dir@creche.test' });
    const admin = await login(t, 'dir@creche.test', ADMIN_PASSWORD);
    const guard = await createGuard(t, { login: 'carlos' });
    const guardToken = await login(t, 'carlos', GUARD_PASSWORD);
    const child = createChild(t);

    const svg = multipart([{ name: 'photo', data: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', filename: 'x.svg', contentType: 'image/svg+xml' }]);
    const bad = await request(t, { method: 'POST', url: `/api/children/${child.id}/photo`, payload: svg.payload, headers: svg.headers, token: admin });
    assert.equal(bad.status, 415);
    assert.equal(bad.body.error.code, 'UNSUPPORTED_MEDIA');

    const lying = multipart([{ name: 'photo', data: 'not really a jpeg', filename: 'x.jpg', contentType: 'image/jpeg' }]);
    const bad2 = await request(t, { method: 'POST', url: `/api/children/${child.id}/photo`, payload: lying.payload, headers: lying.headers, token: admin });
    assert.equal(bad2.status, 415);

    const big = multipart([{ name: 'photo', data: fakeJpeg(2 * 1024 * 1024 + 1), filename: 'big.jpg', contentType: 'image/jpeg' }]);
    const tooBig = await request(t, { method: 'POST', url: `/api/children/${child.id}/photo`, payload: big.payload, headers: big.headers, token: admin });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body.error.code, 'FILE_TOO_LARGE');

    const wrongField = multipart([{ name: 'file', data: fakeJpeg(), filename: 'x.jpg', contentType: 'image/jpeg' }]);
    const wf = await request(t, { method: 'POST', url: `/api/children/${child.id}/photo`, payload: wrongField.payload, headers: wrongField.headers, token: admin });
    assert.equal(wf.status, 400);

    const notMultipart = await request(t, { method: 'POST', url: `/api/children/${child.id}/photo`, payload: { photo: 'x' }, token: admin });
    assert.equal(notMultipart.status, 400);

    const okForm = multipart([{ name: 'photo', data: fakeJpeg(), filename: 'x.jpg', contentType: 'image/jpeg' }]);
    const forbidden = await request(t, { method: 'POST', url: `/api/users/${guard.id}/photo`, payload: okForm.payload, headers: okForm.headers, token: guardToken });
    assert.equal(forbidden.status, 403);
    assert.equal(fs.existsSync(path.join(t.config.dataDir, 'uploads')) ? fs.readdirSync(path.join(t.config.dataDir, 'uploads')).length : 0, 0);
  } finally {
    await t.close();
  }
});
