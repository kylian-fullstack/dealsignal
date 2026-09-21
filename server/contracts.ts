import { z } from "zod";
import type { WebsiteProfile } from "./website-profiler.js";

function isHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export const websiteInputSchema = z.object({
  website: z
    .string()
    .refine(isHttpUrl, "Web musí být platná HTTP nebo HTTPS adresa."),
});

export const signalInputSchema = z.object({
  sourceName: z.string().trim().min(3).max(160),
  sourceUrl: z
    .string()
    .refine(isHttpUrl, "Zdroj musí být platná HTTP nebo HTTPS adresa."),
  observedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum musí být ve formátu YYYY-MM-DD."),
  evidence: z.string().trim().min(20).max(2_000),
  match: z.string().trim().min(12).max(2_000),
  uncertainty: z.string().trim().min(10).max(1_000),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const signalReviewSchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
  expectedVersion: z.number().int().min(1),
  note: z.string().trim().min(8).max(500),
});

export const discoveryRunInputSchema = z.object({
  connector: z.literal("GITHUB_ISSUES"),
  query: z.string().trim().min(3).max(120),
});

export type SignalInput = z.infer<typeof signalInputSchema>;
export type Confidence = SignalInput["confidence"];
export type SignalStatus = "PENDING_REVIEW" | "VERIFIED" | "REJECTED";
export type SignalReviewInput = z.infer<typeof signalReviewSchema>;
export type SignalOrigin =
  | { type: "MANUAL" }
  | {
      type: "DISCOVERY";
      connector: "GITHUB_ISSUES";
      runId: string;
      externalId: string;
    };

export type Workspace = {
  id: string;
  website: string;
  domain: string;
  createdAt: string;
  profile: WebsiteProfile | null;
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

export type SignalAuditEvent = {
  id: string;
  workspaceId: string;
  signalId: string;
  fromStatus: SignalStatus;
  toStatus: SignalStatus;
  note: string;
  createdAt: string;
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

export type ApiError = {
  error: { code: string; message: string; details?: unknown };
};
