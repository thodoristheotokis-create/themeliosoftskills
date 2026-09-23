// netlify/functions/admin-reset.mjs
//
// Επαναφέρει χειροκίνητα έναν λογαριασμό σε "available" σε αυτό το site.
// Προστατεύεται με ADMIN_SECRET.

import { getStore } from '@netlify/blobs';

const POOL = 'themelio';

function checkAuth(req) {
  const secret = req.headers.get('x-admin-secret');
  return secret && process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
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

  const username = body?.username;
  if (!username) {
    return jsonResponse({ ok: false, error: 'bad_request' }, 400);
  }

  const accountsStore = getStore('softskills-accounts');
  const claimsStore = getStore('softskills-claims');

  const { blobs } = await accountsStore.list({ prefix: `${POOL}/` });
  let target = null;
  let targetKey = null;
  for (const ref of blobs) {
    const acc = await accountsStore.get(ref.key, { type: 'json' });
    if (acc && acc.username === username) {
      target = acc;
      targetKey = ref.key;
      break;
    }
  }

  if (!target) {
    return jsonResponse({ ok: false, error: 'not_found' }, 404);
  }
  if (target.status !== 'claimed') {
    return jsonResponse({ ok: true, message: 'Ο λογαριασμός ήταν ήδη available.' });
  }

  if (target.claimToken) {
    await claimsStore.delete(`${POOL}/${target.claimToken}`);
  }

  await accountsStore.setJSON(targetKey, {
    ...target,
    status: 'available',
    claimedAt: null,
    claimToken: null,
  }, {});

  return jsonResponse({ ok: true, message: `Ο λογαριασμός ${username} επανήλθε σε available.` });
};
