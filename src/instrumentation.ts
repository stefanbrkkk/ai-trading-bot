/**
 * Warms the universe sweep at boot.
 *
 * The publication is cached per evaluation instant, and that instant moves once a
 * day at the close, so the first request after a deploy — or the first of any
 * trading day — pays for a 67-symbol sweep. Measured on a fresh deployment that
 * was seven seconds of skeleton on the terminal, the platform's front page,
 * against seven milliseconds for every request after it. A first impression is
 * not a good place to spend the one slow request in a day.
 *
 * Deliberately fire-and-forget: `register` is awaited before the server accepts
 * traffic, so blocking here would move the seven seconds from the first request
 * to the boot itself, which is worse — it delays the twenty-one routes that do
 * not need the engine at all. A request that lands mid-warm simply does what it did
 * before and computes its own snapshot.
 *
 * Failure is silent by design. An unseeded deployment has no ensemble and the
 * sweep throws; that is a state the pages already render, and a crashed boot
 * would take down the compliance, admin and auth surfaces with it.
 */

export async function register(): Promise<void> {
  // The edge runtime has no filesystem, so the artefact store is unavailable
  // there; `register` runs once per runtime.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.AURELIUS_SKIP_WARMUP === '1') return;

  const started = Date.now();
  void (async () => {
    const { getPublication, getUniverseSnapshot } = await import('@/lib/engine/service');
    /*
     * The sweep first, because it is what the publication is derived from and
     * what the store needs — `getUniverseSnapshot` returns the feature vectors
     * only on a cache miss, and this is the miss.
     */
    const snapshot = await getUniverseSnapshot();
    const publication = await getPublication();

    const { persistUniverseSnapshot } = await import('@/lib/engine/persist');
    const persisted = await persistUniverseSnapshot(snapshot);

    process.stdout.write(
      `Aurelius: warmed the ${publication.publicationDate} publication in ${Date.now() - started}ms` +
        (persisted.written
          ? `, published ${persisted.signals} signals to the store\n`
          : ', store already holds this vintage\n'),
    );
  })().catch(() => {
    // Almost always "no trained ensemble" on a deployment that has not been
    // seeded. The terminal says so, with the command to fix it.
  });
}
