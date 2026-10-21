const { US_LOCATIONS } = require('./us-locations.cjs');
const cities = Object.fromEntries(US_LOCATIONS.map((l) => [l.name, [l.lat, l.lng]]));
function proxyConfig(p) {
  if (!p || !['http','https','socks4','socks5'].includes(p.type)) throw Error('Chọn loại proxy hợp lệ.');
  const host = String(p.host || '').trim();
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || host.length > 253) throw Error('Host chỉ gồm tên miền hoặc IPv4, không có http:// hay cổng.');
  if (!/^\d+$/.test(String(p.port)) || +p.port < 1 || +p.port > 65535) throw Error('Cổng phải từ 1 đến 65535.');
  if ((p.type === 'socks5' || p.type === 'socks4') && (p.user || p.password)) throw Error('Bản này hỗ trợ SOCKS5 không mật khẩu. Có tài khoản: dùng HTTP proxy.');
  return {mode:'fixed_servers', proxyRules:`${p.type}://${host}:${+p.port}`, proxyBypassRules:'<-loopback>'};
}
function targetURL(text) {
  const value = String(text || '').trim();
  if (!value) return 'https://www.google.com/';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    const u = new URL(value);
    if (!['https:','http:'].includes(u.protocol) || u.username || u.password) throw Error('Chỉ mở địa chỉ HTTP/HTTPS không chứa mật khẩu.');
    return u.href;
  }
  if (!/\s/.test(value) && value.includes('.')) return targetURL('https://' + value);
  return 'https://www.google.com/search?q=' + encodeURIComponent(value);
}
function checkUS(data) {
  if (data.success !== true || data.country_code !== 'US' || !data.ip) throw Error('Chưa xác minh được IP Hoa Kỳ. Kiểm tra proxy hoặc thử lại.');
  return {ip:data.ip, city:String(data.city || ''), country:'US'};
}
function checkIP(data) {
  if (data.success !== true || !data.ip) throw Error('Không đọc được IP qua proxy. Kiểm tra proxy hoặc thử lại.');
  return {ip:data.ip, city:String(data.city || ''), country:String(data.country_code || data.country || '')};
}
module.exports = {cities, proxyConfig, targetURL, checkUS, checkIP};
