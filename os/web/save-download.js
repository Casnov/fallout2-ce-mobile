// Keep every handed-off disk-backed File URL for this document's lifetime.
// Resuming the engine must neither navigate away nor revoke a browser download.
export function createSaveDownloads({document:page = document,URL:urls = URL} = {}) {
  const retained = new Set(), sources = new WeakMap();
  function dispose() { for (const url of retained) urls.revokeObjectURL(url); retained.clear(); }
  addEventListener('pagehide',dispose,{once:true});
  return result => {
    let url = sources.get(result.blob);
    if (!url) { url = urls.createObjectURL(result.blob); sources.set(result.blob,url); retained.add(url); }
    // Only a detected request error can be reported here. Ordinary downloads
    // have no page-level completion/failure callback; do not invent one.
    const anchor = page.createElement('a'); anchor.href = url; anchor.download = result.filename;
    anchor.hidden = true;
    try { page.body.append(anchor); anchor.click(); } finally { anchor.remove(); }
  };
}
