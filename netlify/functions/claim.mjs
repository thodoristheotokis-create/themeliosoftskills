// netlify/functions/claim.mjs
//
// Αυτό το site εξυπηρετεί ΕΝΑ και μόνο pool (ορίζεται εδώ κάτω, hardcoded).
// Δεν χρειάζεται SITE_TOKEN — αφού το site είναι αφιερωμένο σε ένα
// φροντιστήριο, δεν υπάρχει κίνδυνος να μπερδευτεί με άλλο pool.

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const POOL = 'themelio';
const POOL_SIZE = 50;

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex').slice(0, 24);
}

function isValidClaimToken(token) {
  return typeof token === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(token);
}

const IP_DAILY_CAP = 60;
const MIN_INTERVAL_MS = 1500;

export default async (req, context) => {
  try {
    return await handleClaim(req, context);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'server_error' }, 500);
  }
};

async function handleClaim(req, context) {
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: 'bad_request' }, 400);
  }

  const claimToken = body?.claimToken;
  if (!isValidClaimToken(claimToken)) {
    return jsonResponse({ ok: false, error: 'bad_request' }, 400);
  }

  const claimsStore = getStore('softskills-claims');
  const cursorsStore = getStore('softskills-cursors');
  const accountsStore = getStore('softskills-accounts');
  const throttleStore = getStore('softskills-throttle');

  const claimKey = `${POOL}/${claimToken}`;

  const existing = await claimsStore.get(claimKey, { type: 'json', consistency: 'strong' });
  if (existing) {
    return jsonResponse({ ok: true, username: existing.username, password: existing.password, reused: true });
  }

  const throttleKey = `last-request/${claimToken}`;
  const lastReq = await throttleStore.get(throttleKey, { type: 'json', consistency: 'strong' });
  const now = Date.now();
  if (lastReq && now - lastReq.at < MIN_INTERVAL_MS) {
    return jsonResponse({ ok: false, error: 'too_fast' }, 429);
  }
  await throttleStore.setJSON(throttleKey, { at: now }, {});

  const ip = context.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  const dayBucket = new Date().toISOString().slice(0, 10);
  const ipCapKey = `${POOL}/${hashIp(ip)}/${dayBucket}`;
  const ipCapCurrent = await throttleStore.get(ipCapKey, { type: 'json', consistency: 'strong' });
  const ipCount = ipCapCurrent ? ipCapCurrent.count : 0;
  if (ipCount >= IP_DAILY_CAP) {
    return jsonResponse({ ok: false, error: 'too_many_requests' }, 429);
  }

  let reservedIndex = null;
  for (let attempt = 0; attempt < 8 && reservedIndex === null; attempt++) {
    const cur = await cursorsStore.getWithMetadata(POOL, { type: 'json', consistency: 'strong' });
    const nextIndex = cur && cur.data ? cur.data.nextIndex : 0;

    if (nextIndex >= POOL_SIZE) {
      return jsonResponse({ ok: false, error: 'exhausted' });
    }

    const writeOpts = cur && cur.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true };
    let result;
    try {
      result = await cursorsStore.setJSON(POOL, { nextIndex: nextIndex + 1 }, writeOpts);
    } catch {
      result = null;
    }
    if (result && result.modified) {
      reservedIndex = nextIndex;
    }
  }

  if (reservedIndex === null) {
    return jsonResponse({ ok: false, error: 'busy' }, 503);
  }

  const account = await accountsStore.get(`${POOL}/${reservedIndex}`, { type: 'json', consistency: 'strong' });
  if (!account) {
    return jsonResponse({ ok: false, error: 'server_error' }, 500);
  }

  const claimRecord = {
    pool: POOL,
    index: reservedIndex,
    username: account.username,
    password: account.password,
    claimedAt: new Date().toISOString(),
  };
  let writeResult;
  try {
    writeResult = await claimsStore.setJSON(claimKey, claimRecord, { onlyIfNew: true });
  } catch {
    writeResult = null;
  }

  if (writeResult && writeResult.modified) {
    await accountsStore.setJSON(`${POOL}/${reservedIndex}`, {
      ...account,
      status: 'claimed',
      claimedAt: claimRecord.claimedAt,
      claimToken,
    }, {});

    await throttleStore.setJSON(ipCapKey, { count: ipCount + 1 }, {});

    return jsonResponse({ ok: true, username: account.username, password: account.password, reused: false });
  } else {
    const winner = await claimsStore.get(claimKey, { type: 'json', consistency: 'strong' });
    if (winner) {
      return jsonResponse({ ok: true, username: winner.username, password: winner.password, reused: true });
    }
    return jsonResponse({ ok: false, error: 'server_error' }, 500);
  }
}
