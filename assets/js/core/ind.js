/* 技术指标：全部返回与输入等长的数组，前置 null 表示数据不足 */

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    prev = prev === null ? values[i] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const dif = values.map((_, i) => ef[i] - es[i]);
  const dea = ema(dif, signal);
  const hist = dif.map((v, i) => (v - dea[i]) * 2);
  return { dif, dea, hist };
}

/** 只算最后一根，供实时 tick 用（O(n) 但零分配） */
export function macdLast(values, fast = 12, slow = 26, signal = 9) {
  const kf = 2 / (fast + 1), ks = 2 / (slow + 1), kg = 2 / (signal + 1);
  let ef = null, es = null, dea = null, dif = 0;
  for (let i = 0; i < values.length; i++) {
    const c = values[i];
    ef = ef === null ? c : c * kf + ef * (1 - kf);
    es = es === null ? c : c * ks + es * (1 - ks);
    dif = ef - es;
    dea = dea === null ? dif : dif * kg + dea * (1 - kg);
  }
  return { dif, dea, hist: (dif - dea) * 2 };
}

export function boll(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const up = new Array(values.length).fill(null);
  const low = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sq / period);
    up[i] = mid[i] + mult * sd;
    low[i] = mid[i] - mult * sd;
  }
  return { mid, up, low };
}

/** 只算最后一个 EMA 值，供实时 tick 用 */
export function lastEma(values, period) {
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    prev = prev === null ? values[i] : values[i] * k + prev * (1 - k);
  }
  return prev;
}

export function lastSma(values, period) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

export function lastBoll(values, period = 20, mult = 2) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  const mid = sum / period;
  let sq = 0;
  for (let i = values.length - period; i < values.length; i++) sq += (values[i] - mid) ** 2;
  const sd = Math.sqrt(sq / period);
  return { mid, up: mid + mult * sd, low: mid - mult * sd };
}
