// The rent check: reads JSM's available units and saves them to public/jsm-units.json for the app.
// Runs before `npm run dev`, on its own with `npm run fetch:jsm`, and daily on the live site,
// which passes the file to write as an argument. If JSM can't be read, the last saved file is kept.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LOOKUP_DELAY_MS, lookupUrl, type LatLng } from "../src/geocode.ts";
import {
  defaultAddress,
  JSM_UNITS_URL,
  parseJsmUnits,
  readJsmFeed,
  streetAddress,
  type JsmUnit,
} from "../src/jsm.ts";

const FEED_FILE = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]))
  : new URL("../public/jsm-units.json", import.meta.url);
/** Nominatim and JSM both ask automated visitors to say who they are. */
const USER_AGENT = "apartment-hunter/0.1 (CS 124 student project; one rent check per run)";
const TIME_LIMIT_MS = 20000;

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIME_LIMIT_MS),
  });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  return response.text();
}

/** Coordinates found on earlier runs, so each building is only looked up once. */
async function readKnownPlaces(): Promise<Map<string, { address: string; point: LatLng }>> {
  const known = new Map<string, { address: string; point: LatLng }>();
  try {
    const feed = readJsmFeed(JSON.parse(await readFile(FEED_FILE, "utf8")));
    for (const unit of feed?.units ?? []) {
      if (unit.point) {
        known.set(unit.building, { address: unit.address, point: unit.point });
      }
    }
  } catch {
    // No earlier file yet; every building gets looked up.
  }
  return known;
}

interface NominatimMatch {
  lat: string;
  lon: string;
  address?: { city?: string; town?: string; postcode?: string };
}

/** Finds the building, with the city and zip the map gives, so the zip filter works on it. */
async function locate(building: string): Promise<{ address: string; point: LatLng } | null> {
  const [match] = JSON.parse(
    await fetchText(`${lookupUrl(defaultAddress(building))}&addressdetails=1`),
  ) as NominatimMatch[];
  if (!match) {
    return null;
  }
  const city = match.address?.city ?? match.address?.town ?? "Champaign";
  const zip = match.address?.postcode ? ` ${match.address.postcode}` : "";
  return {
    address: `${streetAddress(building)}, ${city}, IL${zip}`,
    point: { lat: Number(match.lat), lng: Number(match.lon) },
  };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, LOOKUP_DELAY_MS));

/** Looks up buildings not placed on earlier runs, pausing between lookups as Nominatim asks. */
async function placeBuildings(units: JsmUnit[]): Promise<void> {
  const known = await readKnownPlaces();
  const buildings = [...new Set(units.map((unit) => unit.building))];
  for (const building of buildings) {
    if (!known.has(building)) {
      await pause();
      const place = await locate(building).catch(() => null);
      if (place) {
        known.set(building, place);
      }
    }
    const place = known.get(building);
    for (const unit of units.filter((item) => item.building === building)) {
      unit.address = place?.address ?? unit.address;
      unit.point = place?.point ?? null;
    }
  }
}

async function main() {
  let units: JsmUnit[];
  try {
    units = parseJsmUnits(await fetchText(JSM_UNITS_URL));
  } catch (error) {
    console.warn(`Rent check skipped: couldn't reach JSM (${String(error)}). Keeping the last saved rents.`);
    return;
  }
  if (units.length === 0) {
    console.warn("Rent check skipped: JSM's page had no units the check could read. It may have changed its layout.");
    return;
  }
  await placeBuildings(units);
  const feed = { checkedAt: new Date().toISOString(), units };
  await writeFile(FEED_FILE, `${JSON.stringify(feed, null, 1)}\n`);
  const unplaced = units.filter((unit) => unit.point === null).length;
  console.log(
    `Rent check: saved ${units.length} JSM units` + (unplaced > 0 ? ` (${unplaced} couldn't be placed on the map).` : "."),
  );
}

await main();
