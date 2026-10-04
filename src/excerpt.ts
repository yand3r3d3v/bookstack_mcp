// Reading a long page in parts: by section (heading) or by character window, so one huge page
// doesn't fill the model's context.

export interface Heading {
  level: number;
  text: string;
  /** Character offset of the heading line in the Markdown source. */
  offset: number;
}

const MAX_OUTLINE = 80;

/** ATX headings (`## Title`) of a Markdown document, skipping anything inside fenced code blocks. */
export function headings(markdown: string): Heading[] {
  const found: Heading[] = [];
  let fence: string | undefined;
  let offset = 0;
  for (const line of markdown.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    } else if (!fence) {
      const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/);
      if (heading?.[2]) found.push({ level: heading[1].length, text: heading[2], offset });
    }
    offset += line.length + 1;
  }
  return found;
}

export interface ExcerptOptions {
  /** Only the section under this heading. */
  section?: string;
  /** Characters to skip, counted from the start of the page (or of the section). */
  offset: number;
  maxChars: number;
}

/**
 * The requested part of a page. When that isn't everything, a note says what was left out and how
 * to get it: the offset to continue from and the page outline for reading by section.
 */
export function excerpt(markdown: string, { section, offset, maxChars }: ExcerptOptions): string {
  const outline = headings(markdown);
  let start = 0;
  let end = markdown.length;
  if (section !== undefined) {
    const heading = findSection(outline, section);
    const next = outline.find((h) => h.offset > heading.offset && h.level <= heading.level);
    start = heading.offset;
    end = next?.offset ?? markdown.length;
  }
  const length = end - start;
  if (offset > 0 && offset >= length) {
    throw new Error(`offset=${offset} is past the end: the ${section === undefined ? "page" : "section"} is ${length} characters long.`);
  }

  const from = start + offset;
  let to = Math.min(end, from + maxChars);
  if (to < end) {
    // Cut at a line break rather than mid-line.
    const lineBreak = markdown.lastIndexOf("\n", to - 1);
    if (lineBreak > from) to = lineBreak + 1;
  }
  const text = markdown.slice(from, to).trim();
  if (to === end && offset === 0) return text;

  const scope = section === undefined ? "the page" : "this section";
  const notes = [`[Characters ${offset}–${to - start} of ${length} in ${scope}.`];
  if (to < end) notes.push(`Continue with offset=${to - start}${section === undefined ? "" : " and the same section"}.`);
  let note = `${notes.join(" ")}]`;
  if (to < end && section === undefined && outline.length) {
    note += `\nPage outline — pass a heading as \`section\` to read just that part:\n${outlineText(outline)}`;
  }
  return `${text}\n\n${note}`;
}

function findSection(outline: Heading[], wanted: string): Heading {
  const normalize = (text: string) => text.replace(/^#+\s*/, "").trim().toLowerCase();
  const name = normalize(wanted);
  const exact = outline.find((h) => normalize(h.text) === name);
  if (exact) return exact;
  const partial = outline.filter((h) => normalize(h.text).includes(name));
  if (partial.length === 1) return partial[0];
  if (!outline.length) throw new Error("This page has no headings, so it can't be read by section. Use offset instead.");
  const problem = partial.length ? `${partial.length} headings match` : "No heading matches";
  throw new Error(`${problem} ${JSON.stringify(wanted)}. The page's headings:\n${outlineText(outline)}`);
}

function outlineText(outline: Heading[]): string {
  const top = Math.min(...outline.map((h) => h.level));
  const lines = outline.slice(0, MAX_OUTLINE).map((h) => `${"  ".repeat(h.level - top)}- ${h.text}`);
  if (outline.length > MAX_OUTLINE) lines.push(`… and ${outline.length - MAX_OUTLINE} more`);
  return lines.join("\n");
}
