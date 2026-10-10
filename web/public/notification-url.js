/* 通知クリックの遷移先を安全に解決する純粋関数（SW から importScripts。テストは vm で読み込む）。
 * 同一オリジンかつ https:（または localhost の http:）のみ許可。それ以外は '/'。 */
(function (root) {
  function resolveNotificationUrl(raw, origin) {
    try {
      var base = new URL(origin);
      var u = new URL(typeof raw === 'string' && raw ? raw : '/', base);
      var okProto = u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
      if (!okProto || u.origin !== base.origin) return '/';
      return u.pathname + u.search + u.hash;
    } catch (e) {
      return '/';
    }
  }
  root.resolveNotificationUrl = resolveNotificationUrl;
})(typeof self !== 'undefined' ? self : globalThis);
