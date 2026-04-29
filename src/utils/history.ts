import type { HomeAssistant } from '../types/ha';

export interface HistoryPoint {
  s?: string;
  state?: string;
  lu?: number;
  last_changed?: string;
  last_updated?: string;
}

interface CacheEntry {
  data: HistoryPoint[];
  ts: number;
}

const _cache = new Map<string, CacheEntry>();
const _attrTempCache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000;

export async function fetchHistory(
  hass: HomeAssistant,
  entityId: string,
  hours: number,
): Promise<HistoryPoint[] | null> {
  const key = `${entityId}:${hours}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;

  try {
    const result = await hass.callWS<Record<string, HistoryPoint[]>>({
      type: 'history/history_during_period',
      start_time: new Date(Date.now() - hours * 3600 * 1000).toISOString(),
      entity_ids: [entityId],
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: false,
    });
    const data = result[entityId] ?? [];
    _cache.set(key, { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

export function getCachedHistory(entityId: string, hours: number): HistoryPoint[] | null {
  const key = `${entityId}:${hours}`;
  const hit = _cache.get(key);
  return hit && Date.now() - hit.ts < CACHE_TTL ? hit.data : null;
}

// Fetches climate entity history with attributes and extracts current_temperature
// into synthetic HistoryPoints so the graph pipeline can process them unchanged.
export async function fetchHistoryAttrTemp(
  hass: HomeAssistant,
  entityId: string,
  hours: number,
): Promise<HistoryPoint[] | null> {
  const key = `${entityId}:${hours}`;
  const hit = _attrTempCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;

  try {
    const result = await hass.callWS<Record<string, Array<{
      s?: string;
      a?: Record<string, unknown>;
      lu?: number;
      last_updated?: string;
    }>>>({
      type: 'history/history_during_period',
      start_time: new Date(Date.now() - hours * 3600 * 1000).toISOString(),
      entity_ids: [entityId],
      minimal_response: true,
      no_attributes: false,
      significant_changes_only: false,
    });
    const raw = result[entityId] ?? [];
    const data: HistoryPoint[] = raw
      .filter(p => {
        const t = p.a?.current_temperature;
        return t != null && !isNaN(parseFloat(String(t)));
      })
      .map(p => ({
        s: String(p.a!.current_temperature),
        lu: p.lu,
        last_updated: p.last_updated,
      }));
    _attrTempCache.set(key, { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

export function getCachedHistoryAttrTemp(entityId: string, hours: number): HistoryPoint[] | null {
  const key = `${entityId}:${hours}`;
  const hit = _attrTempCache.get(key);
  return hit && Date.now() - hit.ts < CACHE_TTL ? hit.data : null;
}
