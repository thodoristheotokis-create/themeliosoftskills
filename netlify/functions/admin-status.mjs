// netlify/functions/admin-status.mjs
//
// Αναφορά κατάστασης για το μοναδικό pool αυτού του site. Ποτέ δεν επιστρέφει
// passwords. Προστατεύεται με ADMIN_SECRET.

import { getStore } from '@netlify/blobs';

const POOL = 'themelio';

function checkAuth(req) {
  const secret = req.headers.get('x-admin-secret') || new URL(req.url).searchParams.get('secret');
  return secret && process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET;
}

function toCsv(rows) {
  const header = 'username,status,claimedAt';
  const lines = rows.map(r => [r.username, r.status, r.claimedAt || ''].join(','));
  return [header, ...lines].join('\n');
}

export default async (req) => {
  if (!checkAuth(req)) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const accountsStore = getStore('softskills-accounts');
  const cursorsStore = getStore('softskills-cursors');

  const cursor = await cursorsStore.get(POOL, { type: 'json', consistency: 'strong' });
  const released = cursor ? cursor.nextIndex : 0;

  const { blobs } = await accountsStore.list({ prefix: `${POOL}/` });
  let claimed = 0;
  let available = 0;
  const claimedRows = [];

  for (const blobRef of blobs) {
    const acc = await accountsStore.get(blobRef.key, { type: 'json' });
    if (!acc) continue;
    if (acc.status === 'claimed') {
      claimed++;
      claimedRows.push({ username: acc.username, status: acc.status, claimedAt: acc.claimedAt });
    } else {
      available++;
    }
  }

  const summary = { [POOL]: { totalImported: blobs.length, released, claimed, available } };

  const url = new URL(req.url);
  if (url.searchParams.get('format') === 'csv') {
    const csv = toCsv(claimedRows);
    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="soft-skills-claimed.csv"',
      },
    });
  }

  return new Response(JSON.stringify({ ok: true, summary, claimed: claimedRows }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
