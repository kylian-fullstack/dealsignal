import { z } from "zod";
import type { DiscoveryCandidate } from "./contracts.js";

const SEARCH_ENDPOINT = "https://api.github.com/search/issues";
const MAX_CANDIDATES = 5;
const BUYING_INTENT =
  /\b(?:(?:we(?:'re| are)|i(?:'m| am))\s+looking for|need(?:s|ed)? (?:an? |some )?help|seeking|hire|hiring|contractor|external (?:team|developer|agency|vendor)|request for proposal|rfp|wanted)\b/i;
const NON_BUYING_CONTEXT =
  /\b(contribut(?:e|ing|ion|ors?)|good first issue|volunteer|unpaid|usability test|open source|join (?:the|our) organization)\b/i;
const COMMERCIAL_SIGNAL =
  /\b(contractor|external (?:team|developer|agency|vendor)|freelancer|agency|vendor|hire|hiring|paid|budget|request for proposal|rfp)\b/i;

const githubSearchSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.number(),
        number: z.number(),
        title: z.string(),
        body: z.string().nullable(),
        html_url: z.string().url(),
        created_at: z.string(),
        repository_url: z.string().url(),
        pull_request: z.unknown().optional(),
      }),
    )
    .max(100),
});

export type GithubDiscoveryResult = {
  query: string;
  totalFound: number;
  candidates: DiscoveryCandidate[];
};

type GithubConnectorErrorCode =
  "RATE_LIMITED" | "UPSTREAM_FAILED" | "INVALID_RESPONSE";

export class GithubConnectorError extends Error {
  constructor(public readonly code: GithubConnectorErrorCode) {
    super(code);
  }
}

function cleanText(value: string, maxLength: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeSearchPhrase(raw: string) {
  return cleanText(raw.replace(/[^\p{L}\p{N} .+#-]/gu, " "), 120);
}

function repositoryName(repositoryUrl: string) {
  const parts = new URL(repositoryUrl).pathname.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || "GitHub repository";
}

function relevantEvidence(text: string, query: string) {
  if (NON_BUYING_CONTEXT.test(text) || !COMMERCIAL_SIGNAL.test(text))
    return null;
  const normalized = text.toLocaleLowerCase("en");
  const intent = BUYING_INTENT.exec(text);
  if (!intent) return null;
  const topicPositions = query
    .toLocaleLowerCase("en")
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .map((token) => ({
      index: normalized.indexOf(token),
      length: token.length,
    }));
  if (
    !topicPositions.length ||
    topicPositions.some(({ index }) => index === -1)
  )
    return null;

  const topicStart = Math.min(...topicPositions.map(({ index }) => index));
  const topicEnd = Math.max(
    ...topicPositions.map(({ index, length }) => index + length),
  );
  const intentStart = intent.index;
  const intentEnd = intent.index + intent[0].length;
  const distance =
    intentEnd < topicStart
      ? topicStart - intentEnd
      : topicEnd < intentStart
        ? intentStart - topicEnd
        : 0;
  if (distance > 240) return null;

  const start = Math.max(0, Math.min(topicStart, intentStart) - 50);
  const end = Math.min(text.length, Math.max(topicEnd, intentEnd) + 170);
  return cleanText(text.slice(start, end), 500);
}

export function createGithubConnector({
  fetcher = fetch,
}: {
  fetcher?: typeof fetch;
} = {}) {
  return {
    async discover(rawQuery: string): Promise<GithubDiscoveryResult> {
      const query = safeSearchPhrase(rawQuery);
      const since = new Date(Date.now() - 45 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const search = new URL(SEARCH_ENDPOINT);
      search.searchParams.set(
        "q",
        `"${query}" "looking for" is:issue is:open created:>=${since}`,
      );
      search.searchParams.set("sort", "created");
      search.searchParams.set("order", "desc");
      search.searchParams.set("per_page", "20");

      let response: Response;
      try {
        response = await fetcher(search, {
          signal: AbortSignal.timeout(6_000),
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "DealSignal/0.1 (+public-signal-research)",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
      } catch {
        throw new GithubConnectorError("UPSTREAM_FAILED");
      }
      if (response.status === 403 || response.status === 429)
        throw new GithubConnectorError("RATE_LIMITED");
      if (!response.ok) throw new GithubConnectorError("UPSTREAM_FAILED");

      const parsed = githubSearchSchema.safeParse(
        await response.json().catch(() => null),
      );
      if (!parsed.success) throw new GithubConnectorError("INVALID_RESPONSE");

      const candidates = parsed.data.items
        .flatMap((item) => {
          if (item.pull_request || (item.body?.length ?? 0) > 5_000) return [];
          const evidence = relevantEvidence(
            `${item.title}\n${item.body ?? ""}`,
            query,
          );
          return evidence ? [{ item, evidence }] : [];
        })
        .slice(0, MAX_CANDIDATES)
        .map(({ item, evidence }): DiscoveryCandidate => {
          const repository = repositoryName(item.repository_url);
          return {
            externalId: `github-issue-${item.id}`,
            sourceName: `${repository} #${item.number} — ${cleanText(item.title, 140)}`,
            sourceUrl: item.html_url,
            observedAt: item.created_at.slice(0, 10),
            evidence,
            match: `Veřejný GitHub issue obsahuje hledané téma „${query}“.`,
            uncertainty:
              "Automatický návrh: issue může být podpora produktu, komunitní práce nebo již neaktuální požadavek. Před kontaktem je nutná ruční kontrola.",
            confidence: "LOW",
          };
        });

      return { query, totalFound: candidates.length, candidates };
    },
  };
}

export type GithubConnector = ReturnType<typeof createGithubConnector>;
