import { lookup } from "node:dns/promises";
import { Buffer } from "node:buffer";
import { load } from "cheerio";
import * as ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";

const MAX_HTML_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 6_000;

type DnsAddress = { address: string; family: number };
type HtmlDocument = { finalUrl: string; contentType: string; html: string };
type Dependencies = {
  resolveDns: (hostname: string) => Promise<DnsAddress[]>;
  fetchHtml: (url: URL, pinnedAddress: DnsAddress) => Promise<HtmlDocument>;
};

export type WebsiteProfile = {
  sourceUrl: string;
  siteName: string;
  title: string;
  description: string;
  language: string | null;
  headings: string[];
  fetchedAt: string;
};

type ProfileErrorCode =
  | "UNSAFE_TARGET"
  | "DNS_FAILED"
  | "REDIRECT_BLOCKED"
  | "FETCH_TIMEOUT"
  | "FETCH_FAILED"
  | "HTTP_ERROR"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "RESPONSE_TOO_LARGE";

export class ProfileError extends Error {
  readonly code: ProfileErrorCode;

  constructor(code: ProfileErrorCode) {
    super(code);
    this.code = code;
  }
}

function cleanText(value: string | undefined, maxLength = 240) {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isPublicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

async function resolvePublicTarget(
  raw: string,
  resolveDns: Dependencies["resolveDns"],
) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProfileError("UNSAFE_TARGET");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    raw.length > 2_048
  ) {
    throw new ProfileError("UNSAFE_TARGET");
  }

  let addresses: DnsAddress[];
  try {
    addresses = await resolveDns(url.hostname);
  } catch {
    throw new ProfileError("DNS_FAILED");
  }
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new ProfileError("UNSAFE_TARGET");
  }
  return { url, pinnedAddress: addresses[0] };
}

async function fetchPinnedHtml(
  url: URL,
  pinnedAddress: DnsAddress,
): Promise<HtmlDocument> {
  const dispatcher = new Agent({
    connect: {
      lookup: (_hostname, _options, callback) =>
        callback(null, pinnedAddress.address, pinnedAddress.family),
    },
  });
  try {
    const response = await undiciFetch(url, {
      dispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": "DealSignalBot/0.1 (+public metadata research)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (response.status >= 300 && response.status < 400)
      throw new ProfileError("REDIRECT_BLOCKED");
    if (!response.ok) throw new ProfileError("HTTP_ERROR");
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(contentType))
      throw new ProfileError("UNSUPPORTED_CONTENT_TYPE");
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_HTML_BYTES)
      throw new ProfileError("RESPONSE_TOO_LARGE");
    if (!response.body) throw new ProfileError("FETCH_FAILED");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_HTML_BYTES) {
        await reader.cancel();
        throw new ProfileError("RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
    return {
      finalUrl: response.url || url.toString(),
      contentType,
      html: Buffer.concat(chunks).toString("utf8"),
    };
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError")
      throw new ProfileError("FETCH_TIMEOUT");
    throw new ProfileError("FETCH_FAILED");
  } finally {
    await dispatcher.close();
  }
}

export function createWebsiteProfiler(
  dependencies: Dependencies = {
    resolveDns: (hostname) => lookup(hostname, { all: true, verbatim: true }),
    fetchHtml: fetchPinnedHtml,
  },
) {
  return {
    async profile(rawUrl: string): Promise<WebsiteProfile> {
      const { url, pinnedAddress } = await resolvePublicTarget(
        rawUrl,
        dependencies.resolveDns,
      );
      const document = await dependencies.fetchHtml(url, pinnedAddress);
      const $ = load(document.html);
      const title = cleanText(
        $("meta[property='og:title']").attr("content") ||
          $("title").first().text(),
      );
      const description = cleanText(
        $("meta[name='description']").attr("content") ||
          $("meta[property='og:description']").attr("content"),
        500,
      );
      const siteName = cleanText(
        $("meta[property='og:site_name']").attr("content") ||
          title ||
          url.hostname.replace(/^www\./, ""),
      );
      const language =
        cleanText($("html").attr("lang"), 32).split("-")[0] || null;
      const headings = $("h1, h2")
        .toArray()
        .map((element) => cleanText($(element).text(), 160))
        .filter(
          (heading, index, all) =>
            Boolean(heading) && all.indexOf(heading) === index,
        )
        .slice(0, 8);

      return {
        sourceUrl: document.finalUrl,
        siteName,
        title,
        description,
        language,
        headings,
        fetchedAt: new Date().toISOString(),
      };
    },
  };
}

export type WebsiteProfiler = ReturnType<typeof createWebsiteProfiler>;
