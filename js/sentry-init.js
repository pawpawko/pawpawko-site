// Error tracking (Sentry). The SDK bundle is self-hosted from js/vendor/ so
// script-src stays 'self'; the ingest host is allowed in _headers connect-src.
// Errors only — no tracing/replay, to keep the free-tier quota for signal.
(function () {
  if (!window.Sentry) return;
  window.Sentry.init({
    dsn: 'https://2f97b7756b1af3cbb6f0833f236116cb@o4511666502500352.ingest.us.sentry.io/4511666515607552',
    environment: window.location.hostname === 'pawpawko.com' ? 'production' : 'development',
    sampleRate: 1.0,
  });
})();
