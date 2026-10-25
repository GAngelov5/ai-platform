/**
 * Splits "Sync now" requests into the sources this worker knows and the ones
 * it doesn't. Several workers can share one queue during an upgrade or in a
 * mixed dev setup; a worker without a source (an older image, a config
 * without NOTION_*) leaves that request for a worker that has it, instead of
 * failing the whole job and blocking every other requested source.
 */
export function partitionSyncRequests(requested: readonly string[], configured: readonly { id: string }[]) {
  const ids = new Set(configured.map((s) => s.id));
  return { known: requested.filter((r) => ids.has(r)), unknown: requested.filter((r) => !ids.has(r)) };
}
