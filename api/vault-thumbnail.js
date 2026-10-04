// GitHub filename: api/vault-thumbnail.js
// Public, read-only previews. Originals and QR downloads are never changed.
const sharp = require('sharp');
const PROJECT = 'https://bwdsqiwaoqrnnxwmruar.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ3ZHNxaXdhb3Fybm54d21ydWFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2Nzk5MDIsImV4cCI6MjEwNjI1NTkwMn0.OBlLRVr8dLxNU7F-ND0Hmu5oNTc494qnfx8mDBkqq5Q';
const MAX_BYTES = 5 * 1024 * 1024;
const cache = new Map();
const pending = new Map();
let cachedBytes = 0;

sharp.cache(false);
sharp.concurrency(1);

function version(url) {
  let hash = 2166136261;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function boundedRead(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    throw new Error('Image too large');
  }

  const reader = response.body.getReader();
  const parts = [];
  let length = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_BYTES) throw new Error('Image too large');
      parts.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(parts, length);
}

async function makeThumbnail(id, expectedVersion) {
  const query = new URL(PROJECT + '/rest/v1/presets');
  query.searchParams.set('id', 'eq.' + id);
  query.searchParams.set('select', 'image_url,qr_url');
  query.searchParams.set('limit', '1');

  const metadata = await fetch(query, {
    headers: {
      apikey: ANON_KEY,
      Authorization: 'Bearer ' + ANON_KEY
    },
    redirect: 'error',
    signal: AbortSignal.timeout(8000)
  });

  if (!metadata.ok) throw new Error('Preset unavailable');

  const rows = await metadata.json();
  const row = rows[0];
  if (!row) throw new Error('Preset unavailable');

  const image = row.image_url || row.qr_url || '';
  const url = new URL(image);

  if (
    url.origin !== PROJECT ||
    !url.pathname.startsWith('/storage/v1/object/public/presets/') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    version(image) !== expectedVersion
  ) {
    throw new Error('Invalid image');
  }

  const original = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(8000)
  });

  if (
    !original.ok ||
    !/^image\/(jpeg|png|webp)(?:;|$)/i.test(
      original.headers.get('content-type') || ''
    )
  ) {
    throw new Error('Invalid image');
  }

  const bytes = await boundedRead(original);
  const imageReader = sharp(bytes, {
    failOn: 'error',
    limitInputPixels: 32000000,
    animated: false
  });

  const info = await imageReader.metadata();

  if (
    !['jpeg', 'png', 'webp'].includes(info.format) ||
    (info.pages || 1) > 1 ||
    info.width > 8192 ||
    info.height > 8192
  ) {
    throw new Error('Invalid image');
  }

  return imageReader
    .rotate()
    .resize({
      width: 640,
      height: 800,
      fit: 'inside',
      withoutEnlargement: true
    })
    .webp({ quality: 78, effort: 3 })
    .toBuffer();
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }

  const id = req.query?.id;
  const v = req.query?.v;

  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
    typeof v !== 'string' ||
    !/^[0-9a-f]{8}$/.test(v)
  ) {
    return res.status(400).end();
  }

  const key = id + ':' + v;

  try {
    let entry = cache.get(key);

    if (entry && entry.until <= Date.now()) {
      cachedBytes -= entry.bytes.length;
      cache.delete(key);
      entry = null;
    }

    if (!entry) {
      let task = pending.get(key);

      if (!task) {
        if (pending.size >= 2) return res.status(429).end();
        task = makeThumbnail(id, v);
        pending.set(key, task);
      }

      let bytes;
      try {
        bytes = await task;
      } finally {
        if (pending.get(key) === task) pending.delete(key);
      }

      entry = cache.get(key);

      if (!entry) {
        entry = { bytes, until: Date.now() + 300000 };

        while (
          cache.size &&
          (cache.size >= 128 ||
            cachedBytes + bytes.length > 32 * 1024 * 1024)
        ) {
          const first = cache.keys().next().value;
          cachedBytes -= cache.get(first).bytes.length;
          cache.delete(first);
        }

        cache.set(key, entry);
        cachedBytes += bytes.length;
      }
    }

    res.setHeader('Content-Type', 'image/webp');
    res.setHeader(
      'Cache-Control',
      'public, max-age=300, s-maxage=300'
    );

    return res.status(200).send(entry.bytes);
  } catch (_) {
    return res.status(404).end();
  }
};
