// netlify/functions/import-accounts.mjs
//
// Εισάγει λογαριασμούς στο ΜΟΝΑΔΙΚΟ pool αυτού του site. Προστατεύεται με
// ADMIN_SECRET. Ασφαλές να ξανατρέξει: κάθε username εισάγεται μόνο μία φορά.

import { getStore } from '@netlify/blobs';

const POOL = 'themelio';
const POOL_SIZE = 50;

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function checkAuth(req) {
  const secret = req.headers.get('x-admin-secret');
  return secret && process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
  }
  if (!checkAuth(req)) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'bad_request' }, 400);
  }

  const accounts = body?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return jsonResponse({ ok: false, error: 'no_accounts' }, 400);
  }
  if (accounts.length > POOL_SIZE) {
    return jsonResponse({
      ok: false,
      error: 'too_many_rows',
      message: `Αυτό το pool περιμένει έως ${POOL_SIZE} λογαριασμούς, στάλθηκαν ${accounts.length}.`,
    }, 400);
  }

  const accountsStore = getStore('softskills-accounts');
  const cursorsStore = getStore('softskills-cursors');
  const seenStore = getStore('softskills-seen-usernames');

  let imported = 0;
  let skippedDuplicate = 0;
  const errors = [];

  let startIndex = 0;
  const existingCursorMeta = await cursorsStore.get('import-progress-' + POOL, { type: 'json', consistency: 'strong' });
  if (existingCursorMeta) startIndex = existingCursorMeta.importedCount;

  let index = startIndex;
  for (const row of accounts) {
    const username = (row.username || '').toString().trim();
    const password = (row.password || '').toString().trim();
    if (!username || !password) {
      errors.push({ row, reason: 'missing_username_or_password' });
      continue;
    }

    const seenKey = `${POOL}/${username}`;
    let seenResult;
    try {
      seenResult = await seenStore.setJSON(seenKey, { importedAt: new Date().toISOString() }, { onlyIfNew: true });
    } catch {
      seenResult = null;
    }

    if (!seenResult || !seenResult.modified) {
      skippedDuplicate++;
      continue;
    }

    await accountsStore.setJSON(`${POOL}/${index}`, {
      username,
      password,
      pool: POOL,
      index,
      status: 'available',
      claimedAt: null,
      claimToken: null,
    }, {});

    index++;
    imported++;
  }

  await cursorsStore.setJSON('import-progress-' + POOL, { importedCount: index }, {});
  await cursorsStore.setJSON(POOL, { nextIndex: 0 }, { onlyIfNew: true });

  return jsonResponse({
    ok: true,
    pool: POOL,
    imported,
    skippedDuplicate,
    totalNowInPool: index,
    errors,
  });
};
