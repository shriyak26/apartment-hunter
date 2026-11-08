// Reads JSM's available-units page and keeps saved JSM apartments' rents current.
// Kept free of DOM code so it can be unit tested and run by the rent check script.
// Only type imports, because Node runs this file directly in scripts/fetch-jsm.ts.

import type { Building } from "./buildingSearch";
import type { LatLng } from "./geocode";
import type { Listing } from "./listings";

export const JSM_UNITS_URL = "https://jsmliving.com/search-available-units";
const JSM_SITE = "https://jsmliving.com";

export interface JsmUnit {
  /** JSM's own id for the unit, which stays the same when its rent changes. */
  id: string;
  building: string;
  address: string;
  bedrooms: number | null;
  bathrooms: number | null;
  /** A range like $1215-1235 is stored as both ends; the low end counts as the rent. */
  rentLow: number;
  rentHigh: number;
  available: string;
  link: string;
  point: LatLng | null;
}

export interface JsmFeed {
  checkedAt: string;
  units: JsmUnit[];
}

/** The JSM units at one building, for one map pin. */
export interface JsmBuilding {
  building: string;
  point: LatLng;
  units: JsmUnit[];
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function firstMatch(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  return match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : "";
}

function numberOrNull(text: string): number | null {
  return text === "" ? null : Number(text);
}

/** "$1215-1235/Unit" becomes { low: 1215, high: 1235 }; anything without a price is null. */
export function parseRent(text: string): { low: number; high: number } | null {
  const match = /\$\s*(\d[\d,]*)(?:\s*-\s*\$?\s*(\d[\d,]*))?/.exec(text);
  if (!match) {
    return null;
  }
  const low = Number(match[1].replace(/,/g, ""));
  const high = match[2] ? Number(match[2].replace(/,/g, "")) : low;
  return { low: Math.min(low, high), high: Math.max(low, high) };
}

/** "505 S. Fifth - The Station" is at "505 S. Fifth". */
export function streetAddress(building: string): string {
  return building.replace(/\s+-\s+.*$/, "");
}

/** Most JSM buildings are in Champaign; the rent check fills in the real city and zip from the map. */
export function defaultAddress(building: string): string {
  return `${streetAddress(building)}, Champaign, IL`;
}

/** Pulls every unit card out of the available-units page. Cards without a building or rent are skipped. */
export function parseJsmUnits(html: string): JsmUnit[] {
  const units: JsmUnit[] = [];
  const seen = new Set<string>();
  for (const chunk of html.split('<article data-history-node-id="').slice(1)) {
    const end = chunk.indexOf("</article>");
    const card = end === -1 ? chunk : chunk.slice(0, end);
    const id = firstMatch(card, /^(\d+)"/);
    const building = firstMatch(card, /field--name-field-building[^>]*>\s*<a[^>]*>([^<]+)<\/a>/);
    const rent = parseRent(firstMatch(card, /class="rent_unit">([^<]*)</));
    if (id === "" || building === "" || rent === null || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const href = firstMatch(card, /<a href="([^"]+)" class="call-to-action"/);
    units.push({
      id,
      building,
      address: defaultAddress(building),
      bedrooms: numberOrNull(firstMatch(card, /fa-bed"><\/i>\s*<p>([\d.]+)/)),
      bathrooms: numberOrNull(firstMatch(card, /fa-bath"><\/i>\s*<p>([\d.]+)/)),
      rentLow: rent.low,
      rentHigh: rent.high,
      available: firstMatch(card, /Available:<\/span>([^<]*)</),
      link: href === "" ? JSM_UNITS_URL : new URL(href, JSM_SITE).href,
      point: null,
    });
  }
  return units;
}

function isPoint(value: unknown): value is LatLng {
  const point = value as LatLng;
  return typeof point?.lat === "number" && typeof point?.lng === "number";
}

function isUnit(value: unknown): value is JsmUnit {
  const unit = value as JsmUnit;
  return (
    typeof unit?.id === "string" &&
    typeof unit.building === "string" &&
    typeof unit.address === "string" &&
    typeof unit.rentLow === "number" &&
    typeof unit.rentHigh === "number" &&
    typeof unit.link === "string" &&
    (unit.point === null || isPoint(unit.point))
  );
}

/** Checks a downloaded feed, so a damaged file can't break the app. */
export function readJsmFeed(value: unknown): JsmFeed | null {
  const feed = value as JsmFeed;
  if (typeof feed?.checkedAt !== "string" || !Array.isArray(feed.units) || !feed.units.every(isUnit)) {
    return null;
  }
  return feed;
}

/** "Studio", "1 bed", "2 beds". */
export function bedsLabel(bedrooms: number | null): string {
  if (bedrooms === null) {
    return "? beds";
  }
  if (bedrooms === 0) {
    return "Studio";
  }
  return `${bedrooms} ${bedrooms === 1 ? "bed" : "beds"}`;
}

export function unitName(unit: JsmUnit): string {
  return `${unit.building} · ${bedsLabel(unit.bedrooms)}`;
}

function money(amount: number): string {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

/** "$1,215" or "$1,215–$1,235". */
export function rentRangeText(unit: Pick<JsmUnit, "rentLow" | "rentHigh">): string {
  return unit.rentLow === unit.rentHigh ? money(unit.rentLow) : `${money(unit.rentLow)}–${money(unit.rentHigh)}`;
}

/** The unit in the shape the map's Save uses, so a JSM unit saves like any building. */
export function unitAsBuilding(unit: JsmUnit & { point: LatLng }): Building {
  return {
    id: `jsm-${unit.id}`,
    name: unitName(unit),
    address: unit.address,
    website: unit.link,
    agency: "JSM",
    phone: "",
    floors: null,
    units: null,
    point: unit.point,
  };
}

/** One pin per building, for the units the rent check could place on the map. */
export function groupByBuilding(units: JsmUnit[]): JsmBuilding[] {
  const groups = new Map<string, JsmBuilding>();
  for (const unit of units) {
    if (unit.point === null) {
      continue;
    }
    const group = groups.get(unit.building) ?? { building: unit.building, point: unit.point, units: [] };
    group.units.push(unit);
    groups.set(unit.building, group);
  }
  for (const group of groups.values()) {
    group.units.sort((a, b) => (a.bedrooms ?? 99) - (b.bedrooms ?? 99) || a.rentLow - b.rentLow);
  }
  return [...groups.values()].sort((a, b) => a.building.localeCompare(b.building));
}

/**
 * Brings saved JSM apartments up to date with the latest check: a new rent replaces the old one
 * and is remembered as a price change, and units JSM no longer lists are marked so.
 */
export function applyJsmFeed(listings: Listing[], feed: JsmFeed): { listings: Listing[]; priceChanges: Listing[] } {
  const unitsById = new Map(feed.units.map((unit) => [unit.id, unit]));
  const priceChanges: Listing[] = [];
  const updated = listings.map((listing) => {
    if (listing.source?.provider !== "jsm") {
      return listing;
    }
    const unit = unitsById.get(listing.source.unitId);
    if (!unit) {
      return { ...listing, source: { ...listing.source, listed: false, checkedAt: feed.checkedAt } };
    }
    const next: Listing = {
      ...listing,
      source: { ...listing.source, rentRange: rentRangeText(unit), listed: true, checkedAt: feed.checkedAt },
    };
    if (unit.rentLow !== listing.rent) {
      next.rent = unit.rentLow;
      next.priceChange = { from: listing.rent, to: unit.rentLow, date: feed.checkedAt };
      priceChanges.push(next);
    }
    return next;
  });
  return { listings: updated, priceChanges };
}
