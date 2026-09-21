import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { FileStore } from "./store.js";
import { ProfileError } from "./website-profiler.js";

const validSignal = {
  sourceName: "Veřejná poptávka",
  sourceUrl: "https://example.com/poptavka/42",
  observedAt: "2026-09-15",
  evidence: "Firma veřejně hledá dodavatele zákaznického portálu.",
  match: "Dodavatel nabízí vývoj B2B zákaznických portálů.",
  uncertainty: "Není potvrzený rozpočet ani konečný termín.",
  confidence: "MEDIUM",
};

describe("DealSignal API", () => {
  let directory: string;
  let storePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dealsignal-api-"));
    storePath = join(directory, "store.json");
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("creates a workspace and normalizes its domain", async () => {
    const response = await request(createApp(new FileStore(storePath)))
      .post("/api/v1/workspaces")
      .send({ website: "https://www.Example.cz/sluzby?ref=test" });

    expect(response.status).toBe(201);
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    expect(response.body.data).toMatchObject({
      website: "https://www.example.cz/sluzby?ref=test",
      domain: "example.cz",
    });
    expect(response.body.data.id).toEqual(expect.any(String));
  });

  it("returns one consistent validation error shape for an invalid website", async () => {
    const response = await request(createApp(new FileStore(storePath)))
      .post("/api/v1/workspaces")
      .send({ website: "not-a-url" });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "Neplatná vstupní data." },
    });
    expect(response.body.error.details).toBeDefined();
  });

  it("persists a signal and returns it from a fresh store instance", async () => {
    const firstApp = createApp(new FileStore(storePath));
    const workspace = await request(firstApp)
      .post("/api/v1/workspaces")
      .send({ website: "https://example.cz" });
    const workspaceId = workspace.body.data.id;

    const created = await request(firstApp)
      .post(`/api/v1/workspaces/${workspaceId}/signals`)
      .set("Idempotency-Key", "signal-intent-42")
      .send(validSignal);

    const listed = await request(createApp(new FileStore(storePath))).get(
      `/api/v1/workspaces/${workspaceId}/signals?page=1&pageSize=20`,
    );

    expect(created.status).toBe(201);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toMatchObject(validSignal);
    expect(listed.body.pagination).toMatchObject({
      page: 1,
      pageSize: 20,
      totalItems: 1,
      totalPages: 1,
    });
  });

  it("replays the same signal intent without creating a duplicate", async () => {
    const app = createApp(new FileStore(storePath));
    const workspace = await request(app)
      .post("/api/v1/workspaces")
      .send({ website: "https://example.cz" });
    const endpoint = `/api/v1/workspaces/${workspace.body.data.id}/signals`;

    const first = await request(app)
      .post(endpoint)
      .set("Idempotency-Key", "same-intent")
      .send(validSignal);
    const replay = await request(app)
      .post(endpoint)
      .set("Idempotency-Key", "same-intent")
      .send(validSignal);
    const listed = await request(app).get(`${endpoint}?page=1&pageSize=20`);

    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(listed.body.pagination.totalItems).toBe(1);
  });

  it("rejects reuse of an idempotency key with a different signal", async () => {
    const app = createApp(new FileStore(storePath));
    const workspace = await request(app)
      .post("/api/v1/workspaces")
      .send({ website: "https://example.cz" });
    const endpoint = `/api/v1/workspaces/${workspace.body.data.id}/signals`;

    await request(app)
      .post(endpoint)
      .set("Idempotency-Key", "reused-intent")
      .send(validSignal);
    const conflict = await request(app)
      .post(endpoint)
      .set("Idempotency-Key", "reused-intent")
      .send({
        ...validSignal,
        evidence: "Jiný veřejný důkaz s dostatečně dlouhým konkrétním obsahem.",
      });

    expect(conflict.status).toBe(422);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("reviews a signal with optimistic concurrency and records an audit event", async () => {
    const app = createApp(new FileStore(storePath));
    const workspace = await request(app)
      .post("/api/v1/workspaces")
      .send({ website: "https://example.cz" });
    const workspaceId = workspace.body.data.id;
    const created = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/signals`)
      .set("Idempotency-Key", "reviewed-signal")
      .send(validSignal);

    const reviewed = await request(app)
      .patch(
        `/api/v1/workspaces/${workspaceId}/signals/${created.body.data.id}/review`,
      )
      .send({
        status: "VERIFIED",
        expectedVersion: 1,
        note: "Zdroj byl ručně otevřen a jeho datum odpovídá.",
      });
    const audit = await request(app).get(
      `/api/v1/workspaces/${workspaceId}/signals/${created.body.data.id}/audit`,
    );

    expect(created.body.data).toMatchObject({
      status: "PENDING_REVIEW",
      version: 1,
      reviewedAt: null,
    });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.data).toMatchObject({
      status: "VERIFIED",
      version: 2,
    });
    expect(reviewed.body.data.reviewedAt).toEqual(expect.any(String));
    expect(audit.body.data).toEqual([
      expect.objectContaining({
        fromStatus: "PENDING_REVIEW",
        toStatus: "VERIFIED",
        note: "Zdroj byl ručně otevřen a jeho datum odpovídá.",
      }),
    ]);
  });

  it("rejects a stale review instead of overwriting a newer decision", async () => {
    const app = createApp(new FileStore(storePath));
    const workspace = await request(app)
      .post("/api/v1/workspaces")
      .send({ website: "https://example.cz" });
    const workspaceId = workspace.body.data.id;
    const created = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/signals`)
      .set("Idempotency-Key", "concurrent-review")
      .send(validSignal);
    const endpoint = `/api/v1/workspaces/${workspaceId}/signals/${created.body.data.id}/review`;

    await request(app).patch(endpoint).send({
      status: "VERIFIED",
      expectedVersion: 1,
      note: "První kontrola veřejného zdroje byla dokončena.",
    });
    const stale = await request(app).patch(endpoint).send({
      status: "REJECTED",
      expectedVersion: 1,
      note: "Tento požadavek vychází ze staré verze záznamu.",
    });

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
  });

  it("runs public GitHub discovery and persists its review candidates", async () => {
    const githubConnector = {
      discover: vi.fn().mockResolvedValue({
        query: "customer portal",
        totalFound: 1,
        candidates: [
          {
            externalId: "github-issue-101",
            sourceName: "acme/platform #42 — Looking for portal help",
            sourceUrl: "https://github.com/acme/platform/issues/42",
            observedAt: "2026-09-14",
            evidence: "We need an external team to build a customer portal.",
            match: "Text odpovídá hledanému tématu customer portal.",
            uncertainty:
              "Jde o návrh k ručnímu ověření, ne potvrzenou poptávku.",
            confidence: "LOW",
          },
        ],
      }),
    };
    const app = createApp(
      new FileStore(storePath),
      { profile: vi.fn() },
      githubConnector,
    );
    const workspace = await request(app)
      .post("/api/v1/workspaces")
      .send({ website: "https://example.cz" });
    const workspaceId = workspace.body.data.id;

    const discovered = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/discovery-runs`)
      .send({ connector: "GITHUB_ISSUES", query: "customer portal" });
    const listed = await request(
      createApp(
        new FileStore(storePath),
        { profile: vi.fn() },
        githubConnector,
      ),
    ).get(`/api/v1/workspaces/${workspaceId}/discovery-runs`);

    expect(discovered.status).toBe(201);
    expect(discovered.body.data).toMatchObject({
      connector: "GITHUB_ISSUES",
      query: "customer portal",
      totalFound: 1,
    });
    expect(discovered.body.data.candidates).toHaveLength(1);
    expect(listed.body.data).toHaveLength(1);

    const candidate = discovered.body.data.candidates[0];
    const imported = await request(app).post(
      `/api/v1/workspaces/${workspaceId}/discovery-runs/${discovered.body.data.id}/candidates/${candidate.externalId}/import`,
    );
    const replayed = await request(app).post(
      `/api/v1/workspaces/${workspaceId}/discovery-runs/${discovered.body.data.id}/candidates/${candidate.externalId}/import`,
    );

    expect(imported.status).toBe(201);
    expect(imported.body.data).toMatchObject({
      status: "PENDING_REVIEW",
      version: 1,
      origin: {
        type: "DISCOVERY",
        connector: "GITHUB_ISSUES",
        runId: discovered.body.data.id,
        externalId: candidate.externalId,
      },
    });
    expect(replayed.status).toBe(200);
    expect(replayed.body.data.id).toBe(imported.body.data.id);
  });

  it("profiles a public website and persists the extracted metadata", async () => {
    const profile = {
      sourceUrl: "https://example.cz/",
      siteName: "Example Studio",
      title: "B2B portály",
      description: "Vývoj zákaznických portálů pro výrobní firmy.",
      language: "cs",
      headings: ["Portály pro výrobní firmy", "Integrace ERP"],
      fetchedAt: "2026-09-16T00:00:00.000Z",
    };
    const profiler = { profile: vi.fn().mockResolvedValue(profile) };
    const app = createApp(new FileStore(storePath), profiler);
    const workspace = await request(app)
      .post("/api/v1/workspaces")
      .send({ website: "https://example.cz" });

    const refreshed = await request(app)
      .put(`/api/v1/workspaces/${workspace.body.data.id}/profile`)
      .send({});
    const reopened = await request(
      createApp(new FileStore(storePath), profiler),
    )
      .post("/api/v1/workspaces")
      .send({ website: "https://example.cz" });

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data).toEqual(profile);
    expect(reopened.body.data.profile).toEqual(profile);
  });

  it("maps an unsafe profile target to a stable client error", async () => {
    const profiler = {
      profile: vi.fn().mockRejectedValue(new ProfileError("UNSAFE_TARGET")),
    };
    const app = createApp(new FileStore(storePath), profiler);
    const workspace = await request(app)
      .post("/api/v1/workspaces")
      .send({ website: "https://example.cz" });

    const response = await request(app)
      .put(`/api/v1/workspaces/${workspace.body.data.id}/profile`)
      .send({});

    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: "PROFILE_TARGET_BLOCKED",
      message: "Web nelze bezpečně načíst.",
    });
  });
});
