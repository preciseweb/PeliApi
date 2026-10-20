/* Keep provider slugs as identities; encode paths and queries at the HTTP boundary. */
(function (root) {
  function slugPath(slug) {
    return String(slug || '').split('/').map(segment => {
      let decoded = segment;
      try { decoded = decodeURIComponent(segment); } catch { /* A literal percent is encoded below. */ }
      return encodeURIComponent(decoded);
    }).join('/');
  }

  function info(item) {
    const params = new URLSearchParams({ type: item.type || 'movie' });
    if (item.provider) params.set('provider', item.provider);
    return `/info/${slugPath(item.slug)}?${params}`;
  }

  function servers(item, season, episode) {
    const params = new URLSearchParams({ slug: String(item.slug || ''), season: String(season), episode: String(episode) });
    if (item.provider) params.set('provider', item.provider);
    if (item.type) params.set('type', item.type);
    return `/servers?${params}`;
  }

  const requests = Object.freeze({ info, servers });
  if (typeof module !== 'undefined' && module.exports) module.exports = requests;
  else root.PeliRequests = requests;
})(typeof globalThis !== 'undefined' ? globalThis : window);
