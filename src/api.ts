export type ApiConfidence = "LOW" | "MEDIUM" | "HIGH";
export type SignalStatus = "PENDING_REVIEW" | "VERIFIED" | "REJECTED";
export type SignalOrigin =
  | { type: "MANUAL" }
  | {
      type: "DISCOVERY";
      connector: "GITHUB_ISSUES";
      runId: string;
      externalId: string;
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

export type Workspace = {
  id: string;
  website: string;
  domain: string;
  createdAt: string;
  profile: WebsiteProfile | null;
};
export type SignalInput = {
  sourceName: string;
  sourceUrl: string;
  observedAt: string;
  evidence: string;
  match: string;
  uncertainty: string;
  confidence: ApiConfidence;
};
export type Signal = SignalInput & {
  id: string;
  workspaceId: string;
  createdAt: string;
  status: SignalStatus;
  version: number;
  reviewedAt: string | null;
  origin: SignalOrigin;
};
export type SignalReviewInput = {
  status: Exclude<SignalStatus, "PENDING_REVIEW">;
  expectedVersion: number;
  note: string;
};
export type DiscoveryCandidate = SignalInput & {
  externalId: string;
};
export type DiscoveryRun = {
  id: string;
  workspaceId: string;
  connector: "GITHUB_ISSUES";
  query: string;
  totalFound: number;
  candidates: DiscoveryCandidate[];
  startedAt: string;
  completedAt: string;
};
export type Page<T> = {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
};

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: unknown,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as {
    data?: T;
    error?: { code?: string; message?: string; details?: unknown };
  } | null;
  if (!response.ok || !body?.data) {
    throw new ApiClientError(
      body?.error?.code ?? "NETWORK_ERROR",
      body?.error?.message ?? "Server vrátil nečitelnou odpověď.",
      response.status,
      body?.error?.details,
    );
  }
  return body.data;
}

export function createApiClient(fetcher: typeof fetch = fetch) {
  return {
    async createWorkspace(website: string) {
      const response = await fetcher("/api/v1/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ website }),
      });
      return readResponse<Workspace>(response);
    },
    async listSignals(workspaceId: string, page = 1, pageSize = 100) {
      const response = await fetcher(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/signals?page=${page}&pageSize=${pageSize}`,
      );
      const body = (await response.json().catch(() => null)) as
        | (Page<Signal> & {
            error?: { code?: string; message?: string; details?: unknown };
          })
        | null;
      if (!response.ok || !body?.data || !body.pagination)
        throw new ApiClientError(
          body?.error?.code ?? "NETWORK_ERROR",
          body?.error?.message ?? "Signály se nepodařilo načíst.",
          response.status,
          body?.error?.details,
        );
      return body;
    },
    async refreshProfile(workspaceId: string) {
      const response = await fetcher(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/profile`,
        { method: "PUT" },
      );
      return readResponse<WebsiteProfile>(response);
    },
    async createSignal(
      workspaceId: string,
      input: SignalInput,
      idempotencyKey: string,
    ) {
      const response = await fetcher(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/signals`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(input),
        },
      );
      return readResponse<Signal>(response);
    },
    async reviewSignal(
      workspaceId: string,
      signalId: string,
      input: SignalReviewInput,
    ) {
      const response = await fetcher(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/signals/${encodeURIComponent(signalId)}/review`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      return readResponse<Signal>(response);
    },
    async runDiscovery(workspaceId: string, query: string) {
      const response = await fetcher(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/discovery-runs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connector: "GITHUB_ISSUES", query }),
        },
      );
      return readResponse<DiscoveryRun>(response);
    },
    async listDiscoveryRuns(workspaceId: string) {
      const response = await fetcher(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/discovery-runs`,
      );
      return readResponse<DiscoveryRun[]>(response);
    },
    async importDiscoveryCandidate(
      workspaceId: string,
      runId: string,
      externalId: string,
    ) {
      const response = await fetcher(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/discovery-runs/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(externalId)}/import`,
        { method: "POST" },
      );
      return readResponse<Signal>(response);
    },
  };
}

export const api = createApiClient();
