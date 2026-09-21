import express, { type Response } from "express";
import helmet from "helmet";
import {
  discoveryRunInputSchema,
  paginationSchema,
  signalReviewSchema,
  signalInputSchema,
  websiteInputSchema,
  type ApiError,
} from "./contracts.js";
import { FileStore, StoreError } from "./store.js";
import {
  createWebsiteProfiler,
  ProfileError,
  type WebsiteProfiler,
} from "./website-profiler.js";
import {
  createGithubConnector,
  GithubConnectorError,
  type GithubConnector,
} from "./github-connector.js";

function apiError(
  response: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  const body: ApiError = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
  return response.status(status).json(body);
}

export function createApp(
  store: FileStore,
  profiler: WebsiteProfiler = createWebsiteProfiler(),
  githubConnector: GithubConnector = createGithubConnector(),
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "64kb" }));

  app.get("/api/v1/health", (_request, response) =>
    response.json({ data: { status: "ok" } }),
  );

  app.post("/api/v1/workspaces", (request, response) => {
    const parsed = websiteInputSchema.safeParse(request.body);
    if (!parsed.success)
      return apiError(
        response,
        422,
        "VALIDATION_ERROR",
        "Neplatná vstupní data.",
        parsed.error.flatten(),
      );
    const result = store.upsertWorkspace(parsed.data.website);
    return response
      .status(result.created ? 201 : 200)
      .json({ data: result.data });
  });

  app.put(
    "/api/v1/workspaces/:workspaceId/profile",
    async (request, response) => {
      try {
        const workspace = store.getWorkspace(request.params.workspaceId);
        const profile = await profiler.profile(workspace.website);
        return response.json({
          data: store.saveWorkspaceProfile(workspace.id, profile),
        });
      } catch (error) {
        if (error instanceof StoreError && error.code === "NOT_FOUND")
          return apiError(
            response,
            404,
            "WORKSPACE_NOT_FOUND",
            "Výzkumný prostor neexistuje.",
          );
        if (error instanceof ProfileError) {
          if (
            [
              "UNSAFE_TARGET",
              "REDIRECT_BLOCKED",
              "UNSUPPORTED_CONTENT_TYPE",
              "RESPONSE_TOO_LARGE",
            ].includes(error.code)
          ) {
            return apiError(
              response,
              422,
              "PROFILE_TARGET_BLOCKED",
              "Web nelze bezpečně načíst.",
            );
          }
          if (error.code === "FETCH_TIMEOUT")
            return apiError(
              response,
              504,
              "PROFILE_FETCH_TIMEOUT",
              "Načtení webu překročilo časový limit.",
            );
          return apiError(
            response,
            502,
            "PROFILE_FETCH_FAILED",
            "Veřejná metadata webu se nepodařilo načíst.",
          );
        }
        throw error;
      }
    },
  );

  app.get("/api/v1/workspaces/:workspaceId/signals", (request, response) => {
    const pagination = paginationSchema.safeParse(request.query);
    if (!pagination.success)
      return apiError(
        response,
        422,
        "VALIDATION_ERROR",
        "Neplatné stránkování.",
        pagination.error.flatten(),
      );
    try {
      const result = store.listSignals(
        request.params.workspaceId,
        pagination.data.page,
        pagination.data.pageSize,
      );
      return response.json({
        data: result.data,
        pagination: {
          ...pagination.data,
          totalItems: result.totalItems,
          totalPages: Math.ceil(result.totalItems / pagination.data.pageSize),
        },
      });
    } catch (error) {
      if (error instanceof StoreError && error.code === "NOT_FOUND")
        return apiError(
          response,
          404,
          "WORKSPACE_NOT_FOUND",
          "Výzkumný prostor neexistuje.",
        );
      throw error;
    }
  });

  app.post("/api/v1/workspaces/:workspaceId/signals", (request, response) => {
    const parsed = signalInputSchema.safeParse(request.body);
    if (!parsed.success)
      return apiError(
        response,
        422,
        "VALIDATION_ERROR",
        "Neplatná vstupní data.",
        parsed.error.flatten(),
      );
    const idempotencyKey = request.header("Idempotency-Key")?.trim();
    if (
      !idempotencyKey ||
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 128
    )
      return apiError(
        response,
        400,
        "MISSING_IDEMPOTENCY_KEY",
        "Je vyžadován platný Idempotency-Key.",
      );
    try {
      const result = store.createSignal(
        request.params.workspaceId,
        parsed.data,
        idempotencyKey,
      );
      if (result.replayed) response.set("Idempotent-Replayed", "true");
      return response
        .status(result.replayed ? 200 : 201)
        .json({ data: result.data });
    } catch (error) {
      if (error instanceof StoreError && error.code === "NOT_FOUND")
        return apiError(
          response,
          404,
          "WORKSPACE_NOT_FOUND",
          "Výzkumný prostor neexistuje.",
        );
      if (
        error instanceof StoreError &&
        error.code === "IDEMPOTENCY_KEY_REUSED"
      )
        return apiError(
          response,
          422,
          error.code,
          "Idempotency-Key už byl použit s jinými daty.",
        );
      throw error;
    }
  });

  app.patch(
    "/api/v1/workspaces/:workspaceId/signals/:signalId/review",
    (request, response) => {
      const parsed = signalReviewSchema.safeParse(request.body);
      if (!parsed.success)
        return apiError(
          response,
          422,
          "VALIDATION_ERROR",
          "Neplatné rozhodnutí kontroly.",
          parsed.error.flatten(),
        );
      try {
        return response.json({
          data: store.reviewSignal(
            request.params.workspaceId,
            request.params.signalId,
            parsed.data,
          ),
        });
      } catch (error) {
        if (error instanceof StoreError && error.code === "NOT_FOUND")
          return apiError(
            response,
            404,
            "SIGNAL_NOT_FOUND",
            "Signál neexistuje.",
          );
        if (error instanceof StoreError && error.code === "VERSION_CONFLICT")
          return apiError(
            response,
            409,
            error.code,
            "Signál mezitím změnil jiný uživatel. Načtěte aktuální verzi.",
          );
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/workspaces/:workspaceId/signals/:signalId/audit",
    (request, response) => {
      try {
        return response.json({
          data: store.listSignalAudit(
            request.params.workspaceId,
            request.params.signalId,
          ),
        });
      } catch (error) {
        if (error instanceof StoreError && error.code === "NOT_FOUND")
          return apiError(
            response,
            404,
            "SIGNAL_NOT_FOUND",
            "Signál neexistuje.",
          );
        throw error;
      }
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/discovery-runs",
    async (request, response) => {
      const parsed = discoveryRunInputSchema.safeParse(request.body);
      if (!parsed.success)
        return apiError(
          response,
          422,
          "VALIDATION_ERROR",
          "Neplatné zadání veřejného vyhledávání.",
          parsed.error.flatten(),
        );
      try {
        store.getWorkspace(request.params.workspaceId);
        const startedAt = new Date().toISOString();
        const result = await githubConnector.discover(parsed.data.query);
        return response.status(201).json({
          data: store.saveDiscoveryRun(
            request.params.workspaceId,
            { connector: parsed.data.connector, ...result },
            startedAt,
          ),
        });
      } catch (error) {
        if (error instanceof StoreError && error.code === "NOT_FOUND")
          return apiError(
            response,
            404,
            "WORKSPACE_NOT_FOUND",
            "Výzkumný prostor neexistuje.",
          );
        if (
          error instanceof GithubConnectorError &&
          error.code === "RATE_LIMITED"
        )
          return apiError(
            response,
            429,
            "DISCOVERY_RATE_LIMITED",
            "Veřejný zdroj dočasně omezil počet dotazů.",
          );
        if (error instanceof GithubConnectorError)
          return apiError(
            response,
            502,
            "DISCOVERY_SOURCE_FAILED",
            "Veřejný zdroj se nepodařilo bezpečně načíst.",
          );
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/workspaces/:workspaceId/discovery-runs",
    (request, response) => {
      try {
        return response.json({
          data: store.listDiscoveryRuns(request.params.workspaceId),
        });
      } catch (error) {
        if (error instanceof StoreError && error.code === "NOT_FOUND")
          return apiError(
            response,
            404,
            "WORKSPACE_NOT_FOUND",
            "Výzkumný prostor neexistuje.",
          );
        throw error;
      }
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/discovery-runs/:runId/candidates/:externalId/import",
    (request, response) => {
      try {
        const result = store.importDiscoveryCandidate(
          request.params.workspaceId,
          request.params.runId,
          request.params.externalId,
        );
        if (result.replayed) response.set("Idempotent-Replayed", "true");
        return response
          .status(result.replayed ? 200 : 201)
          .json({ data: result.data });
      } catch (error) {
        if (error instanceof StoreError && error.code === "NOT_FOUND")
          return apiError(
            response,
            404,
            "DISCOVERY_CANDIDATE_NOT_FOUND",
            "Uložený návrh veřejného zdroje neexistuje.",
          );
        throw error;
      }
    },
  );

  app.use("/api", (_request, response) =>
    apiError(response, 404, "NOT_FOUND", "API cesta neexistuje."),
  );
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: Response,
      _next: express.NextFunction,
    ) => {
      console.error(error);
      return apiError(
        response,
        500,
        "INTERNAL_ERROR",
        "Server požadavek nedokončil.",
      );
    },
  );
  return app;
}
