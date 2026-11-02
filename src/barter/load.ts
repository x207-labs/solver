import type { Listing } from "@x207/core";
import type { OpenIntent } from "./cycles.js";
import { openListing, type OpenListing } from "./match.js";

export interface LoadBookOptions {
  readApiUrl: string;
  /** Circle id in the read API path, such as `agents-main`. */
  circle: string;
  /** Contract account that signed listings name as `circle`; defaults to `circle`. */
  contractId?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Largest number of pages read. */
  maxPages?: number;
}

async function pages<T>(options: LoadBookOptions, path: string): Promise<T[]> {
  const base = options.readApiUrl.replace(/\/+$/, "");
  const out: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < (options.maxPages ?? 20); page += 1) {
    const url = `${base}/x207/circles/${encodeURIComponent(options.circle)}${path}${path.includes("?") ? "&" : "?"}limit=100${cursor ? `&cursor=${cursor}` : ""}`;
    const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
    if (!response.ok) throw new Error(`read API ${response.status} untuk ${url}`);
    const body = (await response.json()) as { items?: T[]; nextCursor?: string | null };
    out.push(...(body.items ?? []));
    cursor = body.nextCursor ?? null;
    if (cursor === null) break;
  }
  return out;
}

/** Open intents of the intent book (BE-035, `GET …/intents?status=open`) for `findIntentCycles` (SV-010). */
export async function loadOpenIntents(options: LoadBookOptions): Promise<OpenIntent[]> {
  const items = await pages<{ intentHash: string; account: string; offer: OpenIntent["offer"]; need: OpenIntent["need"]; status: string }>(options, "/intents?status=open");
  return items.filter((i) => i.status === "open").map((i) => ({ account: i.account, offer: i.offer, need: i.need, intentHash: i.intentHash }));
}

interface ListingItem {
  account: string;
  offer: { assetType: string; assetClass: Listing["offer"]["asset_class"]; quantity: number; value: string };
  want: ListingItem["offer"];
  terms: string;
  detail: string;
  expiresAt: string;
  discountBps: number;
  acceptPayment: boolean;
  discoverable: boolean;
  nonce: string;
  status: string;
}

const side = (s: ListingItem["offer"]) => ({ asset_type: s.assetType, asset_class: s.assetClass, quantity: s.quantity, value: s.value });

/** Open listings of the listing book (BE-040, `GET …/listings?status=open`), back in the shape that is hashed and signed (SV-013). */
export async function loadOpenListings(options: LoadBookOptions): Promise<OpenListing[]> {
  const items = await pages<ListingItem>(options, "/listings?status=open");
  return items
    .filter((l) => l.status === "open")
    .map((l) =>
      openListing({
        circle: options.contractId ?? options.circle,
        account: l.account,
        offer: side(l.offer),
        want: side(l.want),
        terms: l.terms,
        detail: l.detail,
        expires_at: Math.floor(Date.parse(l.expiresAt) / 1000),
        discount_bps: l.discountBps,
        accept_payment: l.acceptPayment,
        discoverable: l.discoverable,
        nonce: l.nonce,
      }),
    );
}

export interface ActiveBundle {
  bundleId: number;
  termsHash: string;
  epoch: number;
  legs: { payer: string; payee: string; maxAmount: string }[];
}

/** Bundles committed on chain for `epoch` (BE-036, `GET …/bundles?status=active`). */
export async function loadActiveBundles(options: LoadBookOptions & { epoch: number }): Promise<ActiveBundle[]> {
  const items = await pages<ActiveBundle>(options, "/bundles?status=active");
  return items.filter((b) => b.epoch === options.epoch);
}
