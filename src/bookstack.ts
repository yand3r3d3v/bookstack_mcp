// Thin client for the BookStack REST API (https://demo.bookstackapp.com/api/docs).

export type ItemType = "shelf" | "book" | "chapter" | "page";

export const API_PATH: Record<ItemType, string> = {
  shelf: "shelves",
  book: "books",
  chapter: "chapters",
  page: "pages",
};

export interface Tag {
  name: string;
  value?: string;
}

export interface UserRef {
  id: number;
  name: string;
}

export interface Item {
  id: number;
  name: string;
  slug: string;
  type?: string;
  url?: string;
  description?: string;
  tags?: Tag[];
  book_id?: number;
  chapter_id?: number | null;
  book_slug?: string;
  draft?: boolean;
  template?: boolean;
  updated_at?: string;
  // Single-item endpoints return {id, name}; list endpoints return a bare id.
  updated_by?: UserRef | number;
}

export interface Page extends Item {
  book_id: number;
  chapter_id: number | null;
  editor?: string;
  html?: string;
  raw_html?: string;
  markdown?: string;
  revision_count?: number;
}

export interface BookContent extends Item {
  pages?: Item[];
}

export interface Book extends Item {
  contents?: BookContent[];
  shelves?: Item[];
}

export interface Chapter extends Item {
  book_id: number;
  pages?: Item[];
}

export interface Shelf extends Item {
  books?: Item[];
}

export interface SearchResult extends Item {
  book?: Item;
  chapter?: Item;
  preview_html?: { name?: string; content?: string };
}

export interface ListResponse<T> {
  data: T[];
  total: number;
}

export class BookStackError extends Error {
  /** HTTP status from BookStack; undefined when BookStack wasn't reached or didn't answer as its API. */
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

type Query = Record<string, string | number | undefined>;

const STATUS_HINTS: Record<number, string> = {
  401: "Check the API token's Token ID and Token Secret (and that the token hasn't expired).",
  403: 'The token owner lacks permission for this. Their role needs "Access System API" plus the relevant content permissions.',
  404: "It doesn't exist, or the token owner can't see it.",
  429: "BookStack API rate limit hit (default 180 requests/minute).",
};

// A rate-limited request is retried after the wait BookStack asks for, as long as the waits add up
// to no more than this; beyond that the tool call would outlast the client's patience.
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_WAIT_BUDGET = 30;

export class BookStackClient {
  readonly baseUrl: string;
  private readonly auth: string;

  constructor(url: string, tokenId: string, tokenSecret: string) {
    this.baseUrl = url.trim().replace(/\/+$/, "").replace(/\/api$/, "");
    this.auth = `Token ${tokenId}:${tokenSecret}`;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.json<T>("GET", path, query);
  }

  post<T>(path: string, body: object): Promise<T> {
    return this.json<T>("POST", path, undefined, body);
  }

  put<T>(path: string, body: object): Promise<T> {
    return this.json<T>("PUT", path, undefined, body);
  }

  async delete(path: string): Promise<void> {
    await this.send("DELETE", path);
  }

  /** For export endpoints that return a file rather than JSON. */
  async text(path: string): Promise<string> {
    return (await this.send("GET", path)).text();
  }

  private async json<T>(method: string, path: string, query?: Query, body?: object): Promise<T> {
    const res = await this.send(method, path, query, body);
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("json")) {
      throw new BookStackError(
        `Expected JSON from ${res.url} but got "${type}". Is BOOKSTACK_URL the base URL of your BookStack?`,
      );
    }
    return (await res.json()) as T;
  }

  private async send(method: string, path: string, query?: Query, body?: object): Promise<Response> {
    const url = new URL(`${this.baseUrl}/api/${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let res: Response;
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(url, {
          method,
          // A redirect would drop the Authorization header (or turn a POST into a GET),
          // so surface it as a config problem instead of following it.
          redirect: "manual",
          headers: {
            Authorization: this.auth,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        throw new BookStackError(`Can't reach BookStack at ${this.baseUrl}: ${describeFetchError(err)}`);
      }

      const wait = retryAfter(res);
      if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES || waited + wait > RATE_LIMIT_WAIT_BUDGET) break;
      waited += wait;
      await res.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }

    if (res.status >= 300 && res.status < 400) {
      const target = new URL(res.headers.get("location") ?? "", url);
      throw new BookStackError(
        `${url.origin} redirects to ${target.origin}. ` +
          `Set BOOKSTACK_URL to the final address (e.g. https:// instead of http://).`,
      );
    }
    if (!res.ok) throw await toError(res);
    return res;
  }
}

async function toError(res: Response): Promise<BookStackError> {
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    return new BookStackError(
      `HTTP ${res.status} from ${res.url} without a BookStack API response. Is BOOKSTACK_URL the base URL of your BookStack?`,
    );
  }
  const text = await res.text();
  let message = text.slice(0, 300);
  let details = "";
  try {
    const error = JSON.parse(text).error;
    if (error?.message) message = error.message;
    if (error?.validation) {
      details = Object.entries(error.validation as Record<string, string[]>)
        .map(([field, msgs]) => `\n  ${field}: ${msgs.join(" ")}`)
        .join("");
    }
  } catch {
    // Malformed JSON — keep the raw snippet.
  }
  let hint = STATUS_HINTS[res.status];
  if (res.status === 429) hint += ` Retry in ${retryAfter(res)}s.`;
  return new BookStackError(`BookStack ${res.status}: ${message}${details}${hint ? `\n${hint}` : ""}`, res.status);
}

/** Seconds BookStack asks to wait before retrying a rate-limited request. */
function retryAfter(res: Response): number {
  const seconds = Number(res.headers.get("retry-after") ?? NaN);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 2;
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return "request timed out after 30s";
    const cause = err.cause as { code?: string; message?: string } | undefined;
    return cause?.code ?? cause?.message ?? err.message;
  }
  return String(err);
}
