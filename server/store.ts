import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type {
  DiscoveryRun,
  Signal,
  SignalAuditEvent,
  SignalInput,
  SignalOrigin,
  SignalReviewInput,
  Workspace,
} from "./contracts.js";
import type { WebsiteProfile } from "./website-profiler.js";

type StoredIntent = { requestHash: string; signalId: string };
type StoreState = {
  workspaces: Workspace[];
  signals: Signal[];
  auditEvents: SignalAuditEvent[];
  discoveryRuns: DiscoveryRun[];
  idempotency: Record<string, StoredIntent>;
};

const emptyState = (): StoreState => ({
  workspaces: [],
  signals: [],
  auditEvents: [],
  discoveryRuns: [],
  idempotency: {},
});

export class StoreError extends Error {
  constructor(
    public code: "NOT_FOUND" | "IDEMPOTENCY_KEY_REUSED" | "VERSION_CONFLICT",
  ) {
    super(code);
  }
}

export class FileStore {
  constructor(private readonly path: string) {}

  private read(): StoreState {
    if (!existsSync(this.path)) return emptyState();
    const state = JSON.parse(readFileSync(this.path, "utf8")) as StoreState;
    state.workspaces = state.workspaces.map((workspace) => ({
      ...workspace,
      profile: workspace.profile ?? null,
    }));
    state.signals = state.signals.map((signal) => ({
      ...signal,
      status: signal.status ?? "PENDING_REVIEW",
      version: signal.version ?? 1,
      reviewedAt: signal.reviewedAt ?? null,
      origin: signal.origin ?? { type: "MANUAL" },
    }));
    state.auditEvents ??= [];
    state.discoveryRuns ??= [];
    return state;
  }

  private write(state: StoreState) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf8");
    renameSync(temporaryPath, this.path);
  }

  upsertWorkspace(rawWebsite: string) {
    const url = new URL(rawWebsite);
    url.hostname = url.hostname.toLowerCase();
    const domain = url.hostname.replace(/^www\./, "");
    const state = this.read();
    const existing = state.workspaces.find(
      (workspace) => workspace.domain === domain,
    );
    if (existing) return { data: existing, created: false };

    const data: Workspace = {
      id: randomUUID(),
      website: url.toString(),
      domain,
      createdAt: new Date().toISOString(),
      profile: null,
    };
    state.workspaces.push(data);
    this.write(state);
    return { data, created: true };
  }

  getWorkspace(workspaceId: string) {
    const workspace = this.read().workspaces.find(
      (candidate) => candidate.id === workspaceId,
    );
    if (!workspace) throw new StoreError("NOT_FOUND");
    return workspace;
  }

  saveWorkspaceProfile(workspaceId: string, profile: WebsiteProfile) {
    const state = this.read();
    const workspace = state.workspaces.find(
      (candidate) => candidate.id === workspaceId,
    );
    if (!workspace) throw new StoreError("NOT_FOUND");
    workspace.profile = profile;
    this.write(state);
    return profile;
  }

  listSignals(workspaceId: string, page: number, pageSize: number) {
    const state = this.read();
    if (!state.workspaces.some((workspace) => workspace.id === workspaceId))
      throw new StoreError("NOT_FOUND");
    const matching = state.signals
      .filter((signal) => signal.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const offset = (page - 1) * pageSize;
    return {
      data: matching.slice(offset, offset + pageSize),
      totalItems: matching.length,
    };
  }

  createSignal(
    workspaceId: string,
    input: SignalInput,
    idempotencyKey: string,
    origin: SignalOrigin = { type: "MANUAL" },
  ) {
    const state = this.read();
    if (!state.workspaces.some((workspace) => workspace.id === workspaceId))
      throw new StoreError("NOT_FOUND");
    const intentKey = `${workspaceId}:${idempotencyKey}`;
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ input, origin }))
      .digest("hex");
    const priorIntent = state.idempotency[intentKey];
    if (priorIntent) {
      if (priorIntent.requestHash !== requestHash)
        throw new StoreError("IDEMPOTENCY_KEY_REUSED");
      const replayed = state.signals.find(
        (signal) => signal.id === priorIntent.signalId,
      );
      if (!replayed) throw new StoreError("NOT_FOUND");
      return { data: replayed, replayed: true };
    }

    const data: Signal = {
      ...input,
      id: randomUUID(),
      workspaceId,
      createdAt: new Date().toISOString(),
      status: "PENDING_REVIEW",
      version: 1,
      reviewedAt: null,
      origin,
    };
    state.signals.push(data);
    state.idempotency[intentKey] = { requestHash, signalId: data.id };
    this.write(state);
    return { data, replayed: false };
  }

  reviewSignal(
    workspaceId: string,
    signalId: string,
    input: SignalReviewInput,
  ) {
    const state = this.read();
    const signal = state.signals.find(
      (candidate) =>
        candidate.id === signalId && candidate.workspaceId === workspaceId,
    );
    if (!signal) throw new StoreError("NOT_FOUND");
    if (signal.version !== input.expectedVersion)
      throw new StoreError("VERSION_CONFLICT");

    const reviewedAt = new Date().toISOString();
    const event: SignalAuditEvent = {
      id: randomUUID(),
      workspaceId,
      signalId,
      fromStatus: signal.status,
      toStatus: input.status,
      note: input.note,
      createdAt: reviewedAt,
    };
    signal.status = input.status;
    signal.version += 1;
    signal.reviewedAt = reviewedAt;
    state.auditEvents.push(event);
    this.write(state);
    return signal;
  }

  listSignalAudit(workspaceId: string, signalId: string) {
    const state = this.read();
    if (
      !state.signals.some(
        (signal) =>
          signal.id === signalId && signal.workspaceId === workspaceId,
      )
    )
      throw new StoreError("NOT_FOUND");
    return state.auditEvents
      .filter(
        (event) =>
          event.workspaceId === workspaceId && event.signalId === signalId,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  saveDiscoveryRun(
    workspaceId: string,
    result: Pick<
      DiscoveryRun,
      "connector" | "query" | "totalFound" | "candidates"
    >,
    startedAt: string,
  ) {
    const state = this.read();
    if (!state.workspaces.some((workspace) => workspace.id === workspaceId))
      throw new StoreError("NOT_FOUND");
    const run: DiscoveryRun = {
      ...result,
      id: randomUUID(),
      workspaceId,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    state.discoveryRuns.push(run);
    this.write(state);
    return run;
  }

  listDiscoveryRuns(workspaceId: string) {
    const state = this.read();
    if (!state.workspaces.some((workspace) => workspace.id === workspaceId))
      throw new StoreError("NOT_FOUND");
    return state.discoveryRuns
      .filter((run) => run.workspaceId === workspaceId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  importDiscoveryCandidate(
    workspaceId: string,
    runId: string,
    externalId: string,
  ) {
    const state = this.read();
    const run = state.discoveryRuns.find(
      (candidate) =>
        candidate.id === runId && candidate.workspaceId === workspaceId,
    );
    const candidate = run?.candidates.find(
      (item) => item.externalId === externalId,
    );
    if (!run || !candidate) throw new StoreError("NOT_FOUND");
    const { externalId: _externalId, ...input } = candidate;
    return this.createSignal(
      workspaceId,
      input,
      `import:${runId}:${externalId}`,
      {
        type: "DISCOVERY",
        connector: run.connector,
        runId,
        externalId,
      },
    );
  }
}
