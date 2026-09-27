// Helpers that turn API objects into compact text for the model.

import type { Item, Tag } from "./bookstack.js";

/** `[page:12] Name` — the id format the tools accept back. */
export function ref(type: string, item: { id: number; name: string }): string {
  return `[${type}:${item.id}] ${item.name}`;
}

/** BookStack calls shelves "bookshelf" in search results and some responses. */
export function normalizeType(type: string | undefined): string {
  return type === "bookshelf" ? "shelf" : (type ?? "item");
}

export function flags(item: Item): string {
  return (item.draft ? " (draft)" : "") + (item.template ? " (template)" : "");
}

export function tagsText(tags: Tag[] | undefined): string {
  return (tags ?? []).map((t) => (t.value ? `${t.name}=${t.value}` : t.name)).join(", ");
}

export function oneLine(text: string | undefined, max = 140): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#039": "'", "#39": "'", nbsp: " " };

export function htmlToText(html: string | undefined): string {
  return (html ?? "").replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#0?39|nbsp);/g, (_, e: string) => ENTITIES[e]);
}

export function day(iso: string | undefined): string {
  return iso?.slice(0, 10) ?? "?";
}

/** Browsers submit textareas with CRLF, so stored Markdown can contain \r\n. */
export function lf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
