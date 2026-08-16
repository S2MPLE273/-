const crypto = require('node:crypto');

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const EPOCH = Date.UTC(2026, 0, 1);
const DAY_MS = 86400000;
// 时钟容差：签发机与验证机时钟偏差（不校时/时区错误）在此窗口内不判"未生效"（4h，服务方拍板：误差一般不会更大）
const SKEW_GRACE_MS = 4 * 3600000;
// lastSeen 回拨容差：吸收 NTP 校时回调（时钟先快后被校正），超出仍判回拨
const LASTSEEN_GRACE_MS = 3600000;

// 设备码归一化：大小写/连字符/花括号一律忽略，仅保留 hex 字符（keygen 与验证端必须一致）
function normalizeDeviceCode(s) { return String(s).toLowerCase().replace(/[^0-9a-f]/g, ''); }

function packBits(bits) { // bits: array of [value, width] — BigInt 累加，支持 >32 位
  let buf = 0n, used = 0;
  const bytes = [];
  for (const [v, w] of bits) { buf = (buf << BigInt(w)) | BigInt(v); used += w; }
  const pad = (8 - (used % 8)) % 8;
  buf <<= BigInt(pad); used += pad;
  for (let i = used - 8; i >= 0; i -= 8) bytes.push(Number((buf >> BigInt(i)) & 0xffn));
  return Buffer.from(bytes);
}
function unpackBits(buf, widths) {
  let used = 0, idx = 0, acc = 0;
  const out = [];
  for (const w of widths) {
    let v = 0;
    for (let i = 0; i < w; i++) {
      if (used === 0) { acc = buf[idx++]; used = 8; }
      v = (v << 1) | ((acc >> 7) & 1);
      acc = (acc << 1) & 0xff; used--;
    }
    out.push(v);
  }
  return out;
}
function b32encode(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let s = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) s += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return s;
}
function b32decode(s) {
  let bits = '';
  for (const c of s) { const i = ALPHABET.indexOf(c); if (i < 0) return null; bits += i.toString(2).padStart(5, '0'); }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function group(s) { return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16); }

function createLicense({ masterKey }) {
  function sign(payloadBuf) {
    return crypto.createHmac('sha256', Buffer.from(masterKey, 'hex')).update(payloadBuf).digest().slice(0, 3);
  }
  function generate({ deviceCode = '', validDays = 1, issueTime = Date.now() } = {}) {
    const vd = Math.max(1, Math.min(63, Math.floor(validDays) || 1)); // 钳位到 6 位（1-63），防止静默回绕
    const t = Math.floor(issueTime / 60000) * 60000; // 签发时刻分钟取整（密钥内嵌时刻）
    const issueDay = Math.floor((t - EPOCH) / DAY_MS);
    const withinDay = (t - EPOCH) % DAY_MS;
    const issueHour = Math.floor(withinDay / 3600000);
    const issueMinute = Math.floor((withinDay % 3600000) / 60000);
    const norm = normalizeDeviceCode(deviceCode);
    if (norm && norm.length !== 32) throw new Error('invalid device code: ' + deviceCode);
    // 设备绑定：提供设备码 → version 3（tagHash 校验）；否则 version 2（tagHash 忽略）
    const version = norm ? 3 : 2;
    const tagHash = norm ? crypto.createHash('sha256').update(norm, 'utf8').digest().readUInt16BE(0) : 0;
    // 52 bits payload（补零至 56 bits = 7 字节）+ 3 字节签名 = 10 字节 = 80 bits = 16 chars = 4 组
    const payload = packBits([[version, 2], [issueDay, 16], [vd, 6], [tagHash, 16], [issueHour, 5], [issueMinute, 6], [0, 1]]);
    const sig = sign(payload);
    const body = b32encode(Buffer.concat([payload, sig]));
    return 'DKC-' + group(body.slice(0, 16));
  }
  // state 必须是普通对象；持久化仅通过 state.save(state) 回调（Task 9 传入文件存储实现）
  function verify(key, { now = () => Date.now(), machineGuid = 'unknown', state } = {}) {
    if (typeof key !== 'string' || !/^DKC-[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/.test(key)) return { ok: false, reason: 'invalid' };
    const body = key.slice(4).replace(/-/g, '');
    const buf = b32decode(body);
    if (!buf || buf.length < 10) return { ok: false, reason: 'invalid' };
    const payload = buf.slice(0, 7);
    const sig = buf.slice(7, 10);
    if (!crypto.timingSafeEqual(sign(payload), sig)) return { ok: false, reason: 'invalid' };
    const [version, issueDay, validDays, tagHash, issueHour, issueMinute] = unpackBits(payload, [2, 16, 6, 16, 5, 6, 1]);
    if (version !== 2 && version !== 3) return { ok: false, reason: 'invalid' };
    const cur = now();
    // 有效期 = 签发时刻（分钟精度）+ validDays×24h，精确到分钟
    const issueMs = EPOCH + issueDay * DAY_MS + issueHour * 3600000 + issueMinute * 60000;
    const expireMs = issueMs + validDays * DAY_MS;
    const keyHash = crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
    const st = state && (state.entries || (state.entries = {}));
    const rec = st && st[keyHash];
    // 容差窗口：签发机时钟略快于本机不判未生效（v0.2.5 起 4h），超出才拒绝
    if (cur < issueMs - SKEW_GRACE_MS) return { ok: false, reason: 'not_yet_valid' };
    if (cur >= expireMs) return { ok: false, reason: 'expired' };
    if (version === 3 && crypto.createHash('sha256').update(normalizeDeviceCode(machineGuid), 'utf8').digest().readUInt16BE(0) !== tagHash) {
      return { ok: false, reason: 'machine_mismatch' };
    }
    if (st) {
      if (rec && rec.machineGuid !== machineGuid) return { ok: false, reason: 'machine_mismatch' };
      // 回拨容差 1h：吸收 NTP 校时回调；超出仍判回拨
      if (rec && cur < rec.lastSeen - LASTSEEN_GRACE_MS) return { ok: false, reason: 'clock_rollback' };
    }
    if (st) {
      st[keyHash] = { machineGuid, lastSeen: cur };
      if (typeof state.save === 'function') state.save(state);
    }
    return { ok: true, remainingMs: expireMs - cur, keyHash };
  }
  return { generate, verify };
}

module.exports = { createLicense, ALPHABET, EPOCH, packBits, unpackBits, b32encode, b32decode, normalizeDeviceCode };
