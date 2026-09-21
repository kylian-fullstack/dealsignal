import { describe, expect, it, vi } from "vitest";
import {
  createGithubConnector,
  GithubConnectorError,
} from "./github-connector.js";

const githubResponse = {
  total_count: 8,
  incomplete_results: false,
  items: [
    {
      id: 101,
      number: 42,
      title: "Looking for help with a customer portal",
      body: "We need an external team to build a customer portal for distributors.",
      html_url: "https://github.com/acme/platform/issues/42",
      created_at: "2026-09-14T10:00:00Z",
      repository_url: "https://api.github.com/repos/acme/platform",
    },
    {
      id: 102,
      number: 43,
      title: "Implementation pull request",
      body: "This is not a buying signal.",
      html_url: "https://github.com/acme/platform/pull/43",
      created_at: "2026-09-14T11:00:00Z",
      repository_url: "https://api.github.com/repos/acme/platform",
      pull_request: { url: "https://api.github.com/pulls/43" },
    },
    {
      id: 103,
      number: 44,
      title: "Implement customer portal billing screen",
      body: "Add a billing table and plan selector to the existing portal.",
      html_url: "https://github.com/acme/platform/issues/44",
      created_at: "2026-09-14T12:00:00Z",
      repository_url: "https://api.github.com/repos/acme/platform",
    },
    {
      id: 104,
      number: 45,
      title: "Looking for database migration help",
      body: "We need a contractor for a PostgreSQL migration.",
      html_url: "https://github.com/acme/platform/issues/45",
      created_at: "2026-09-14T13:00:00Z",
      repository_url: "https://api.github.com/repos/acme/platform",
    },
    {
      id: 105,
      number: 46,
      title: "Customer portal release notes",
      body: `${"Implementation detail. ".repeat(30)} Looking for a contractor for an unrelated mobile application.`,
      html_url: "https://github.com/acme/platform/issues/46",
      created_at: "2026-09-14T14:00:00Z",
      repository_url: "https://api.github.com/repos/acme/platform",
    },
    {
      id: 106,
      number: 47,
      title: "Looking for a customer portal contractor — daily digest",
      body: `Bulk digest with unrelated listings. ${"x".repeat(6_000)}`,
      html_url: "https://github.com/acme/platform/issues/47",
      created_at: "2026-09-14T15:00:00Z",
      repository_url: "https://api.github.com/repos/acme/platform",
    },
    {
      id: 107,
      number: 48,
      title: "Looking for customer portal contributors",
      body: "Good first issue for an open source volunteer who wants to contribute.",
      html_url: "https://github.com/acme/platform/issues/48",
      created_at: "2026-09-14T16:00:00Z",
      repository_url: "https://api.github.com/repos/acme/platform",
    },
    {
      id: 108,
      number: 49,
      title: "We are looking for a customer portal module",
      body: "Internal implementation requirements for the next release.",
      html_url: "https://github.com/acme/platform/issues/49",
      created_at: "2026-09-14T17:00:00Z",
      repository_url: "https://api.github.com/repos/acme/platform",
    },
  ],
};

describe("GitHub issue discovery connector", () => {
  it("maps recent public issues to low-confidence review candidates", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify(githubResponse), { status: 200 }),
      );
    const connector = createGithubConnector({ fetcher });

    const result = await connector.discover("customer portal");

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      externalId: "github-issue-101",
      sourceUrl: "https://github.com/acme/platform/issues/42",
      observedAt: "2026-09-14",
      confidence: "LOW",
    });
    expect(result.candidates[0].evidence).toContain("external team");
    const requestedUrl = new URL(String(fetcher.mock.calls[0][0]));
    expect(requestedUrl.hostname).toBe("api.github.com");
    expect(requestedUrl.searchParams.get("q")).toContain("customer portal");
    expect(requestedUrl.searchParams.get("q")).toContain("is:issue");
    expect(requestedUrl.searchParams.get("q")).toContain("looking for");
  });

  it("returns a stable rate-limit error instead of pretending there are no results", async () => {
    const connector = createGithubConnector({
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("{}", { status: 403 })),
    });

    const failure = await connector
      .discover("customer portal")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GithubConnectorError);
    expect(failure).toMatchObject({ code: "RATE_LIMITED" });
  });
});
