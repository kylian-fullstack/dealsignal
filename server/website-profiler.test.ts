import { describe, expect, it, vi } from "vitest";
import { ProfileError, createWebsiteProfiler } from "./website-profiler.js";

const publicDns = vi
  .fn()
  .mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

describe("website profiler security boundary", () => {
  it("rejects localhost and private DNS targets before fetching", async () => {
    const fetcher = vi.fn();
    const profiler = createWebsiteProfiler({
      resolveDns: vi
        .fn()
        .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]),
      fetchHtml: fetcher,
    });

    const failure = await profiler
      .profile("https://localhost/admin")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProfileError);
    expect(failure).toMatchObject({ code: "UNSAFE_TARGET" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS URLs and credential-bearing URLs", async () => {
    const profiler = createWebsiteProfiler({
      resolveDns: publicDns,
      fetchHtml: vi.fn(),
    });

    await expect(profiler.profile("http://example.com")).rejects.toMatchObject({
      code: "UNSAFE_TARGET",
    });
    await expect(
      profiler.profile("https://user:secret@example.com"),
    ).rejects.toMatchObject({ code: "UNSAFE_TARGET" });
  });

  it("extracts bounded public metadata without rendering page HTML", async () => {
    const profiler = createWebsiteProfiler({
      resolveDns: publicDns,
      fetchHtml: vi.fn().mockResolvedValue({
        finalUrl: "https://example.com/",
        contentType: "text/html; charset=utf-8",
        html: `<!doctype html><html lang="cs"><head><title>  Example Studio  </title><meta name="description" content="Vývoj bezpečných B2B portálů."><meta property="og:site_name" content="Example"></head><body><h1>Portály pro výrobní firmy</h1><h2>Integrace ERP a CRM</h2><script>ignore()</script></body></html>`,
      }),
    });

    const profile = await profiler.profile("https://example.com");

    expect(profile).toMatchObject({
      sourceUrl: "https://example.com/",
      siteName: "Example",
      title: "Example Studio",
      description: "Vývoj bezpečných B2B portálů.",
      language: "cs",
      headings: ["Portály pro výrobní firmy", "Integrace ERP a CRM"],
    });
    expect(profile.fetchedAt).toEqual(expect.any(String));
  });

  it("rejects redirects and oversized responses", async () => {
    const redirecting = createWebsiteProfiler({
      resolveDns: publicDns,
      fetchHtml: vi
        .fn()
        .mockRejectedValue(new ProfileError("REDIRECT_BLOCKED")),
    });
    const oversized = createWebsiteProfiler({
      resolveDns: publicDns,
      fetchHtml: vi
        .fn()
        .mockRejectedValue(new ProfileError("RESPONSE_TOO_LARGE")),
    });

    await expect(
      redirecting.profile("https://example.com"),
    ).rejects.toMatchObject({ code: "REDIRECT_BLOCKED" });
    await expect(
      oversized.profile("https://example.com"),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });
});
