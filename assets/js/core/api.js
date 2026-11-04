/* 与服务端通信：REST + SSE */

const json = async (url) => {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
};

export const api = {
  market: () => json('/api/market'),
  klines: (symbol, interval, limit = 400, before = 0) =>
    json(`/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`
      + (before ? `&before=${before}` : '')),
  depth: (symbol, limit = 20) =>
    json(`/api/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`),
  trades: (symbol, limit = 30) =>
    json(`/api/trades?symbol=${encodeURIComponent(symbol)}&limit=${limit}`),
  perp: (symbol) => json(`/api/perp?symbol=${encodeURIComponent(symbol)}`),
  intraday: (symbol) => json(`/api/intraday?symbol=${encodeURIComponent(symbol)}`),
  oihist: (symbol, period = '5m', limit = 500) =>
    json(`/api/oihist?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=${limit}`),
  lsrh: (symbol, period = '5m', limit = 60) =>
    json(`/api/lsrh?symbol=${encodeURIComponent(symbol)}&period=${period}&limit=${limit}`),
  fundingHist: (symbol) =>
    json(`/api/fundinghist?symbol=${encodeURIComponent(symbol)}`),
  status: () => json('/api/status'),
  sub(payload) {
    return fetch('/api/sub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  },
};

export function openStream({ onMessage, onOpen, onError }) {
  let es = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    es = new EventSource('/api/stream');
    es.onopen = () => onOpen && onOpen();
    es.onerror = () => onError && onError();
    es.onmessage = (e) => {
      if (!e.data) return;
      try {
        onMessage(JSON.parse(e.data));
      } catch (err) {
        /* 忽略坏帧 */
      }
    };
  };

  connect();
  return {
    close() {
      closed = true;
      if (es) es.close();
    },
  };
}
