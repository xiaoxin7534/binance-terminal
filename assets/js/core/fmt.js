/* 数字格式化：中文习惯 + 交易终端精度 */

export function fmtPrice(v, dp = 2) {
  if (v === null || v === undefined || !isFinite(v)) return '--';
  if (dp > 4) return v.toFixed(dp);
  return v.toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** 万 / 亿 缩写，用于成交量、成交额 */
export function fmtCompact(v, dp = 2) {
  if (v === null || v === undefined || !isFinite(v)) return '--';
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(dp) + '万亿';
  if (a >= 1e8) return (v / 1e8).toFixed(dp) + '亿';
  if (a >= 1e4) return (v / 1e4).toFixed(dp) + '万';
  if (a >= 1) return v.toFixed(dp);
  return v.toFixed(4);
}

export function fmtPct(v, dp = 2) {
  if (v === null || v === undefined || !isFinite(v)) return '--';
  return (v > 0 ? '+' : '') + v.toFixed(dp) + '%';
}

export function fmtSigned(v, dp = 2) {
  if (v === null || v === undefined || !isFinite(v)) return '--';
  return (v > 0 ? '+' : '') + fmtPrice(v, dp);
}

export function dirClass(v) {
  return v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
}

/** 成交额/成交量自适应精度：数量级越小，小数位越多 */
export function volDp(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return 0;
  if (a >= 1e3) return 1;
  if (a >= 1) return 2;
  return 4;
}

/** 盘口/逐笔数量：保留 4 位有效数字，避免小数量显示成 0.0000 */
export function fmtQty(v) {
  if (v === null || v === undefined || !isFinite(v)) return '--';
  const a = Math.abs(v);
  if (a >= 10000) return (v / 1000).toFixed(1) + 'K';
  if (a >= 1000) return v.toFixed(1);
  if (a >= 100) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  if (a >= 0.01) return v.toFixed(4);
  if (a === 0) return '0';
  return v.toPrecision(3);
}

export function clockTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

export function ivLabel(iv) {
  return ({ '1m': '1分', '5m': '5分', '15m': '15分', '30m': '30分',
            '1h': '1时', '2h': '2时', '4h': '4时', '1d': '日线',
            '1w': '周线' })[iv] || iv;
}

/** 合约 symbol 带 @f 后缀，展示时要去掉 */
export function symLabel(sym) {
  return sym && sym.endsWith('@f') ? sym.slice(0, -2) : (sym || '');
}

/** 资金费率：币安按 8 小时计，值很小，固定 4 位小数 */
export function fmtFunding(v) {
  if (v === null || v === undefined || !isFinite(v)) return '--';
  return (v > 0 ? '+' : '') + v.toFixed(4) + '%';
}
