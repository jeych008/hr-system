function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || "unknown";
}

function createSecurityState(config) {
  let redis = null;
  const rateBuckets = new Map();
  const captchas = new Map();

  async function init() {
    if (!config.redisUrl) return;
    const { createClient } = require("redis");
    redis = createClient({
      url: config.redisUrl,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: retries => retries > 5 ? new Error("Redis reconnect limit reached") : Math.min(retries * 100, 3000)
      }
    });
    redis.on("error", err => console.error("Redis error:", err.message));
    await redis.connect();
    await redis.ping();
  }

  async function rateLimit(req, bucket, limit, windowMs) {
    const key = `hr:rate:${bucket}:${clientIp(req, config.trustProxy)}`;
    if (redis) {
      const count = await redis.incr(key);
      if (count === 1) await redis.pExpire(key, windowMs);
      return count <= limit;
    }
    const now = Date.now();
    const hits = (rateBuckets.get(key) || []).filter(ts => now - ts < windowMs);
    if (hits.length >= limit) return false;
    hits.push(now);
    rateBuckets.set(key, hits);
    if (rateBuckets.size > 1000) {
      for (const [itemKey, itemHits] of rateBuckets) {
        const live = itemHits.filter(ts => now - ts < windowMs);
        if (live.length) rateBuckets.set(itemKey, live);
        else rateBuckets.delete(itemKey);
      }
    }
    return true;
  }

  async function saveCaptcha(id, answer, ttlMs) {
    if (redis) {
      await redis.set(`hr:captcha:${id}`, String(answer), { PX: ttlMs });
      return;
    }
    captchas.set(id, { answer: String(answer), expiresAt: Date.now() + ttlMs });
  }

  async function consumeCaptcha(id, supplied) {
    if (!id) return false;
    let expected;
    if (redis) {
      expected = await redis.getDel(`hr:captcha:${id}`);
    } else {
      const record = captchas.get(id);
      captchas.delete(id);
      if (record && record.expiresAt >= Date.now()) expected = record.answer;
    }
    return expected !== null && expected !== undefined && String(expected) === String(supplied || "").trim();
  }

  async function close() {
    if (redis?.isOpen) await redis.quit();
  }

  return { init, rateLimit, saveCaptcha, consumeCaptcha, close, clientIp: req => clientIp(req, config.trustProxy) };
}

module.exports = { createSecurityState };
