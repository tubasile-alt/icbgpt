'use strict';

function createAsyncCache(loader, { ttlMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  let cached = null;
  let expiresAt = 0;
  let inFlight = null;

  async function get({ force = false } = {}) {
    const currentTime = now();
    if (!force && cached && currentTime < expiresAt) return { ...cached, cache: 'hit' };
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const value = await loader();
        cached = { value, loadedAt: new Date(now()).toISOString(), stale: false };
        expiresAt = now() + ttlMs;
        return { ...cached, cache: 'miss' };
      } catch (error) {
        if (cached) {
          // Evita martelar a fonte externa em toda requisição durante uma indisponibilidade.
          expiresAt = now() + Math.min(ttlMs, 60_000);
          cached = { ...cached, stale: true, refreshError: error.message };
          return { ...cached, cache: 'stale' };
        }
        throw error;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function clear() {
    cached = null;
    expiresAt = 0;
  }

  return { clear, get };
}

module.exports = { createAsyncCache };
