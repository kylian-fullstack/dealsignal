import { describe, expect, it, vi } from "vitest";
import { ApiClientError, createApiClient } from "./api";

describe("DealSignal API client", () => {
  it("creates a workspace through the versioned endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: "workspace-1",
            website: "https://example.cz/",
            domain: "example.cz",
            createdAt: "2026-09-15T10:00:00.000Z",
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = createApiClient(fetcher);
    const workspace = await client.createWorkspace("https://example.cz");

    expect(workspace.domain).toBe("example.cz");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/workspaces",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps the structured server error code and message", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: "Neplatná vstupní data.",
          },
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = createApiClient(fetcher);
    const failure = await client
      .createWorkspace("bad-url")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiClientError);
    expect(failure).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Neplatná vstupní data.",
      status: 422,
    });
  });

  it("sends one stable idempotency key when creating a signal", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: "signal-1",
            workspaceId: "workspace-1",
            sourceName: "Veřejný zdroj",
            sourceUrl: "https://example.com/source",
            observedAt: "2026-09-15",
            evidence: "Konkrétní veřejně dostupný důkaz o poptávce.",
            match: "Přesná shoda s nabízenou službou.",
            uncertainty: "Není potvrzen rozpočet ani termín.",
            confidence: "MEDIUM",
            createdAt: "2026-09-15T10:00:00.000Z",
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = createApiClient(fetcher);
    await client.createSignal(
      "workspace-1",
      {
        sourceName: "Veřejný zdroj",
        sourceUrl: "https://example.com/source",
        observedAt: "2026-09-15",
        evidence: "Konkrétní veřejně dostupný důkaz o poptávce.",
        match: "Přesná shoda s nabízenou službou.",
        uncertainty: "Není potvrzen rozpočet ani termín.",
        confidence: "MEDIUM",
      },
      "signal-intent-42",
    );

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/workspaces/workspace-1/signals",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": "signal-intent-42",
        }),
      }),
    );
  });

  it("refreshes public website metadata through the workspace profile resource", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            sourceUrl: "https://example.cz/",
            siteName: "Example Studio",
            title: "B2B portály",
            description: "Vývoj portálů pro firmy.",
            language: "cs",
            headings: ["Portály pro výrobní firmy"],
            fetchedAt: "2026-09-16T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = createApiClient(fetcher);
    const profile = await client.refreshProfile("workspace-1");

    expect(profile.siteName).toBe("Example Studio");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/workspaces/workspace-1/profile",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("sends the expected version when a human reviews a signal", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: "signal-1",
            status: "VERIFIED",
            version: 2,
            reviewedAt: "2026-09-16T01:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = createApiClient(fetcher);
    await client.reviewSignal("workspace-1", "signal-1", {
      status: "VERIFIED",
      expectedVersion: 1,
      note: "Zdroj jsem ručně ověřil.",
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/workspaces/workspace-1/signals/signal-1/review",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          status: "VERIFIED",
          expectedVersion: 1,
          note: "Zdroj jsem ručně ověřil.",
        }),
      }),
    );
  });

  it("starts a persisted public-source discovery run", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: "run-1",
            workspaceId: "workspace-1",
            connector: "GITHUB_ISSUES",
            query: "customer portal",
            totalFound: 0,
            candidates: [],
            startedAt: "2026-09-16T01:00:00.000Z",
            completedAt: "2026-09-16T01:00:01.000Z",
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = createApiClient(fetcher);
    const run = await client.runDiscovery("workspace-1", "customer portal");

    expect(run.id).toBe("run-1");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/workspaces/workspace-1/discovery-runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          connector: "GITHUB_ISSUES",
          query: "customer portal",
        }),
      }),
    );
  });

  it("imports a discovery candidate by server-side provenance", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: "signal-1",
            status: "PENDING_REVIEW",
            origin: {
              type: "DISCOVERY",
              connector: "GITHUB_ISSUES",
              runId: "run-1",
              externalId: "github-issue-101",
            },
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = createApiClient(fetcher);
    await client.importDiscoveryCandidate(
      "workspace-1",
      "run-1",
      "github-issue-101",
    );

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/workspaces/workspace-1/discovery-runs/run-1/candidates/github-issue-101/import",
      { method: "POST" },
    );
  });
});
