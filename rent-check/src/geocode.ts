// Turns addresses into map coordinates using OpenStreetMap's free Nominatim service.
// Kept free of DOM code so it can be unit tested.

export interface LatLng {
  lat: number;
  lng: number;
}

export type Located = { status: "found"; point: LatLng } | { status: "not-found" } | { status: "failed" };

export type Lookup = (url: string) => Promise<Response>;

export const GEOCODE_STORAGE_KEY = "apartment-hunter.geocode.v1";

/** Nominatim's usage policy allows at most one request per second. */
export const LOOKUP_DELAY_MS = 1100;

/** Prefers Champaign-Urbana, so an address without a city doesn't land in another state. */
const CHAMPAIGN_URBANA_VIEWBOX = "-88.35,40.20,-88.10,40.03";

type SavedLocations = Record<string, LatLng | null>;

function cacheKey(address: string): string {
  return address.trim().toLowerCase();
}

function readSaved(storage: Storage): SavedLocations {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(GEOCODE_STORAGE_KEY) ?? "{}");
    return parsed !== null && typeof parsed === "object" ? (parsed as SavedLocations) : {};
  } catch {
    return {};
  }
}

export function remember(storage: Storage, address: string, point: LatLng | null) {
  try {
    const saved = readSaved(storage);
    saved[cacheKey(address)] = point;
    storage.setItem(GEOCODE_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Storage is blocked; the address just gets looked up again next time.
  }
}

/** Unit numbers aren't on the map and can make the whole address fail to match. */
export function withoutUnit(address: string): string {
  return address
    .replace(/,?\s*\b(?:unit|apt\.?|apartment|suite|ste\.?)\s+[\w-]+/gi, "")
    .replace(/,?\s*#\s*[\w-]+/g, "")
    .trim();
}

/** Also used by the rent check script, which locates JSM buildings ahead of time. */
export function lookupUrl(address: string): string {
  const params = new URLSearchParams({
    format: "jsonv2",
    limit: "1",
    countrycodes: "us",
    viewbox: CHAMPAIGN_URBANA_VIEWBOX,
    q: withoutUnit(address),
  });
  return `https://nominatim.openstreetmap.org/search?${params}`;
}

/** Where an address was found before, null if it wasn't found, or undefined if it hasn't been looked up yet. */
export function knownPoint(address: string, storage: Storage): LatLng | null | undefined {
  return address.trim() === "" ? null : readSaved(storage)[cacheKey(address)];
}

function isKnown(address: string, storage: Storage): boolean {
  return address.trim() === "" || cacheKey(address) in readSaved(storage);
}

/** Finds an address, remembering the answer. A failed lookup is retried next time. */
export async function locateAddress(address: string, storage: Storage, lookup: Lookup = fetch): Promise<Located> {
  if (address.trim() === "") {
    return { status: "not-found" };
  }
  const saved = readSaved(storage)[cacheKey(address)];
  if (saved !== undefined) {
    return saved === null ? { status: "not-found" } : { status: "found", point: saved };
  }
  try {
    const response = await lookup(lookupUrl(address));
    if (!response.ok) {
      return { status: "failed" };
    }
    const [match] = (await response.json()) as { lat: string; lon: string }[];
    const point = match ? { lat: Number(match.lat), lng: Number(match.lon) } : null;
    remember(storage, address, point);
    return point ? { status: "found", point } : { status: "not-found" };
  } catch {
    return { status: "failed" };
  }
}

export interface LocateOptions {
  storage: Storage;
  lookup?: Lookup;
  wait?: () => Promise<void>;
  signal?: AbortSignal;
}

function waitForNextLookup(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, LOOKUP_DELAY_MS));
}

/** Locates addresses one at a time, pausing between lookups that really go to the service. */
export async function locateAll(
  addresses: string[],
  { storage, lookup = fetch, wait = waitForNextLookup, signal }: LocateOptions,
  onResult: (address: string, result: Located) => void,
): Promise<void> {
  let lookedUpAlready = false;
  for (const address of addresses) {
    if (signal?.aborted) {
      return;
    }
    if (!isKnown(address, storage)) {
      if (lookedUpAlready) {
        await wait();
        if (signal?.aborted) {
          return;
        }
      }
      lookedUpAlready = true;
    }
    onResult(address, await locateAddress(address, storage, lookup));
  }
}

/**
 * The line under the map saying how many saved places have pins. Places with no address yet are named
 * separately from addresses the lookup couldn't find, since each needs a different fix.
 */
export function describePinPlacement(total: number, noAddress: string[], notFound: string[], lookupFailed: boolean): string {
  const placed = total - noAddress.length - notFound.length;
  const parts = [`${placed} of your ${total} saved on the map.`];
  if (notFound.length > 0) {
    parts.push(
      lookupFailed
        ? `Couldn't reach the address lookup for: ${notFound.join(", ")}. Check your internet connection, then switch to List and back to Map.`
        : `Couldn't find: ${notFound.join(", ")}. Edit the address to include street, city, state, and zip.`,
    );
  }
  if (noAddress.length > 0) {
    parts.push(`No address yet: ${noAddress.join(", ")}. Add one with Edit to put ${noAddress.length === 1 ? "it" : "them"} on the map.`);
  }
  return parts.join(" ");
}
