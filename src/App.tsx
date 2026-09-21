import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  api,
  ApiClientError,
  type ApiConfidence,
  type DiscoveryCandidate,
  type DiscoveryRun,
  type Signal,
  type SignalInput,
  type SignalStatus,
  type WebsiteProfile,
} from "./api";
import "./App.css";

type Stage = "ready" | "checking" | "workspace";

const exampleSignal: Signal = {
  id: "example",
  workspaceId: "example",
  createdAt: "2026-09-12T12:00:00.000Z",
  sourceName: "Veřejný příspěvek firmy — pouze ukázka formátu",
  sourceUrl: "https://example.com/verejny-prispevek",
  observedAt: "2026-09-12",
  evidence:
    "„Hledáme externí kapacitu pro zavedení nového zákaznického portálu.“",
  match:
    "Pokud firma prodává vývoj portálů, jde o konkrétní veřejně ověřitelný důvod k osobnímu oslovení.",
  uncertainty:
    "Není ověřeno, zda je poptávka stále otevřená ani kdo rozhoduje.",
  confidence: "MEDIUM",
  status: "PENDING_REVIEW",
  version: 1,
  reviewedAt: null,
  origin: { type: "MANUAL" },
};

function hostname(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("cs-CZ", { dateStyle: "long" }).format(
    new Date(`${value}T12:00:00`),
  );
}

function ageLabel(value: string) {
  const age = Math.floor(
    (Date.now() - new Date(`${value}T12:00:00`).getTime()) / 86_400_000,
  );
  if (age < 0) return "Datum je v budoucnu";
  if (age === 0) return "Dnes";
  if (age === 1) return "1 den";
  if (age < 5) return `${age} dny`;
  return `${age} dní`;
}

function confidenceLabel(confidence: ApiConfidence) {
  return ({ LOW: "Nízká", MEDIUM: "Střední", HIGH: "Vysoká" } as const)[
    confidence
  ];
}

function candidateLabel(count: number) {
  if (count === 1) return "1 doložený kandidát";
  if (count > 1 && count < 5) return `${count} doložení kandidáti`;
  return `${count} doložených kandidátů`;
}

function statusLabel(status: SignalStatus) {
  return {
    PENDING_REVIEW: "Čeká na ověření",
    VERIFIED: "Ručně ověřeno",
    REJECTED: "Zamítnuto",
  }[status];
}

function SignalCard({
  signal,
  isExample = false,
  isReviewing = false,
  onReview,
}: {
  signal: Signal;
  isExample?: boolean;
  isReviewing?: boolean;
  onReview?: (
    signal: Signal,
    status: "VERIFIED" | "REJECTED",
    note: string,
  ) => Promise<void>;
}) {
  const [reviewNote, setReviewNote] = useState("");

  async function review(status: "VERIFIED" | "REJECTED") {
    if (!onReview || reviewNote.trim().length < 8) return;
    await onReview(signal, status, reviewNote.trim());
  }

  return (
    <article className="signal-card">
      <div className="signal-card__topline">
        <span className={isExample ? "badge badge--example" : "badge"}>
          {isExample
            ? "Příklad výstupu"
            : signal.origin.type === "DISCOVERY"
              ? "Návrh z GitHub discovery"
              : "Ručně vložený kandidát"}
        </span>
        <span className="confidence" data-confidence={signal.confidence}>
          {confidenceLabel(signal.confidence)} jistota
        </span>
      </div>
      <p className="review-status" data-status={signal.status}>
        {statusLabel(signal.status)} · verze {signal.version}
      </p>
      <h3>{signal.sourceName}</h3>
      <dl>
        <div>
          <dt>Zdroj</dt>
          <dd>
            <a href={signal.sourceUrl} target="_blank" rel="noreferrer">
              Otevřít veřejný zdroj <span aria-hidden="true">↗</span>
            </a>
          </dd>
        </div>
        <div>
          <dt>Datum zdroje</dt>
          <dd>{formatDate(signal.observedAt)}</dd>
        </div>
        <div>
          <dt>Stáří signálu</dt>
          <dd>{ageLabel(signal.observedAt)}</dd>
        </div>
      </dl>
      <div className="signal-copy">
        <p>
          <strong>Důkaz</strong>
          {signal.evidence}
        </p>
        <p>
          <strong>Proč to sedí</strong>
          {signal.match}
        </p>
        <p className="uncertainty">
          <strong>Nejistota</strong>
          {signal.uncertainty}
        </p>
      </div>
      {!isExample && signal.status === "PENDING_REVIEW" && onReview && (
        <div className="review-panel">
          <label htmlFor={`review-note-${signal.id}`}>
            Poznámka ruční kontroly
          </label>
          <textarea
            id={`review-note-${signal.id}`}
            value={reviewNote}
            onChange={(event) => setReviewNote(event.target.value)}
            rows={2}
            minLength={8}
            placeholder="Co jste ve veřejném zdroji skutečně ověřili?"
          />
          <div className="review-panel__actions">
            <button
              type="button"
              disabled={isReviewing || reviewNote.trim().length < 8}
              onClick={() => void review("VERIFIED")}
            >
              {isReviewing ? "Ukládám…" : "Potvrdit signál"}
            </button>
            <button
              type="button"
              className="button--quiet"
              disabled={isReviewing || reviewNote.trim().length < 8}
              onClick={() => void review("REJECTED")}
            >
              Zamítnout
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function App() {
  const [website, setWebsite] = useState("");
  const [websiteError, setWebsiteError] = useState("");
  const [stage, setStage] = useState<Stage>("ready");
  const [signals, setSignals] = useState<Signal[]>([]);
  const [profile, setProfile] = useState<WebsiteProfile | null>(null);
  const [profileError, setProfileError] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [showEvidenceForm, setShowEvidenceForm] = useState(false);
  const [formError, setFormError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [reviewingId, setReviewingId] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [discoveryRuns, setDiscoveryRuns] = useState<DiscoveryRun[]>([]);
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const [discoveryError, setDiscoveryError] = useState("");
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [importingCandidateId, setImportingCandidateId] = useState("");
  const company = useMemo(() => hostname(website), [website]);

  async function startResearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const parsed = new URL(website);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
    } catch {
      setWebsiteError("Vlož platnou adresu včetně https://.");
      return;
    }
    setWebsiteError("");
    setProfileError("");
    setStage("checking");
    try {
      const workspace = await api.createWorkspace(website);
      const [page, previousRuns] = await Promise.all([
        api.listSignals(workspace.id),
        api.listDiscoveryRuns(workspace.id),
      ]);
      let loadedProfile = workspace.profile;
      try {
        loadedProfile = await api.refreshProfile(workspace.id);
      } catch (error) {
        setProfileError(
          error instanceof ApiClientError
            ? `${error.message}${workspace.profile ? " Zobrazuji poslední uložený profil." : ""}`
            : "Veřejná metadata webu se nepodařilo načíst.",
        );
      }
      setWebsite(workspace.website);
      setWorkspaceId(workspace.id);
      setSignals(page.data);
      setDiscoveryRuns(previousRuns);
      setProfile(loadedProfile);
      setDiscoveryQuery(
        loadedProfile?.title || loadedProfile?.headings[0] || "",
      );
      setStage("workspace");
    } catch (error) {
      setWebsiteError(
        error instanceof ApiClientError
          ? error.message
          : "API není dostupné. Spusť vývojový server znovu.",
      );
      setStage("ready");
    }
  }

  async function addEvidence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const sourceUrl = String(data.get("sourceUrl") ?? "");
    const evidence = String(data.get("evidence") ?? "").trim();
    const match = String(data.get("match") ?? "").trim();
    try {
      const parsed = new URL(sourceUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
    } catch {
      setFormError("Zdroj musí být veřejná adresa začínající https://.");
      return;
    }
    if (evidence.length < 20 || match.length < 12) {
      setFormError(
        "Doplň konkrétní důkaz i vysvětlení shody, ne jen název zdroje.",
      );
      return;
    }
    if (!workspaceId) {
      setFormError("Výzkumný prostor nemá serverový identifikátor.");
      return;
    }
    const input: SignalInput = {
      sourceName:
        String(data.get("sourceName") ?? "").trim() || "Veřejný zdroj",
      sourceUrl,
      observedAt: String(
        data.get("observedAt") ?? new Date().toISOString().slice(0, 10),
      ),
      evidence,
      match,
      uncertainty:
        String(data.get("uncertainty") ?? "").trim() ||
        "Aktuálnost a rozhodovatel zatím nejsou ověřeny.",
      confidence: String(data.get("confidence") ?? "MEDIUM") as ApiConfidence,
    };
    setIsSaving(true);
    try {
      const created = await api.createSignal(
        workspaceId,
        input,
        crypto.randomUUID(),
      );
      setSignals((current) => [created, ...current]);
      setFormError("");
      setShowEvidenceForm(false);
      form.reset();
    } catch (error) {
      setFormError(
        error instanceof ApiClientError
          ? error.message
          : "Důkaz se nepodařilo uložit.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function reviewSignal(
    signal: Signal,
    status: "VERIFIED" | "REJECTED",
    note: string,
  ) {
    if (!workspaceId) return;
    setReviewingId(signal.id);
    setReviewError("");
    try {
      const reviewed = await api.reviewSignal(workspaceId, signal.id, {
        status,
        expectedVersion: signal.version,
        note,
      });
      setSignals((current) =>
        current.map((candidate) =>
          candidate.id === reviewed.id ? reviewed : candidate,
        ),
      );
    } catch (error) {
      setReviewError(
        error instanceof ApiClientError
          ? error.message
          : "Rozhodnutí se nepodařilo uložit.",
      );
    } finally {
      setReviewingId("");
    }
  }

  async function runDiscovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = discoveryQuery.trim();
    if (query.length < 3) {
      setDiscoveryError("Doplň alespoň jedno konkrétní téma nabídky.");
      return;
    }
    if (!workspaceId) return;
    setIsDiscovering(true);
    setDiscoveryError("");
    try {
      const run = await api.runDiscovery(workspaceId, query);
      setDiscoveryRuns((current) => [run, ...current]);
    } catch (error) {
      setDiscoveryError(
        error instanceof ApiClientError
          ? error.message
          : "Veřejné vyhledávání se nepodařilo dokončit.",
      );
    } finally {
      setIsDiscovering(false);
    }
  }

  async function importCandidate(runId: string, candidate: DiscoveryCandidate) {
    if (!workspaceId) return;
    setImportingCandidateId(candidate.externalId);
    setDiscoveryError("");
    try {
      const created = await api.importDiscoveryCandidate(
        workspaceId,
        runId,
        candidate.externalId,
      );
      setSignals((current) =>
        current.some((signal) => signal.id === created.id)
          ? current
          : [created, ...current],
      );
    } catch (error) {
      setDiscoveryError(
        error instanceof ApiClientError
          ? error.message
          : "Návrh se nepodařilo převzít do fronty.",
      );
    } finally {
      setImportingCandidateId("");
    }
  }

  function reset() {
    setWebsite("");
    setWorkspaceId("");
    setSignals([]);
    setDiscoveryRuns([]);
    setDiscoveryQuery("");
    setDiscoveryError("");
    setProfile(null);
    setProfileError("");
    setShowEvidenceForm(false);
    setReviewError("");
    setStage("ready");
  }

  return (
    <main>
      <nav className="nav" aria-label="Hlavní navigace">
        <a className="brand" href="#start" onClick={reset}>
          <span>◆</span> DealSignal
        </a>
        <span className="nav__note">
          Veřejné důkazy. Žádné vymyšlené leady.
        </span>
      </nav>
      {stage !== "workspace" ? (
        <section className="hero" id="start" aria-labelledby="page-title">
          <p className="eyebrow">OBCHODNÍ INTELIGENCE PRO B2B</p>
          <h1 id="page-title">Kdo vás právě může potřebovat?</h1>
          <p className="hero__lead">
            Vložte web firmy. DealSignal připraví výzkumný prostor pro veřejně
            doložené nákupní signály — se zdrojem, datem a mírou nejistoty.
          </p>
          <form className="url-form" onSubmit={startResearch} noValidate>
            <label htmlFor="website">Web firmy nebo e-shopu</label>
            <div className="url-form__row">
              <input
                id="website"
                name="website"
                type="url"
                inputMode="url"
                autoComplete="url"
                placeholder="https://vasefirma.cz"
                value={website}
                onChange={(event) => setWebsite(event.target.value)}
                aria-describedby="website-help website-error"
                aria-invalid={Boolean(websiteError)}
              />
              <button type="submit" disabled={stage === "checking"}>
                {stage === "checking" ? "Připravuji…" : "Spustit výzkum"}{" "}
                <span aria-hidden="true">→</span>
              </button>
            </div>
            <p id="website-help">
              V této první verzi se žádná data neschovávají a nic se automaticky
              neodesílá.
            </p>
            {websiteError && (
              <p className="form-error" id="website-error" role="alert">
                {websiteError}
              </p>
            )}
          </form>
          <div className="trust-row" aria-label="Zásady DealSignalu">
            <span>01 — jen veřejné zdroje</span>
            <span>02 — věk každého signálu</span>
            <span>03 — člověk schvaluje další krok</span>
          </div>
        </section>
      ) : (
        <section className="workspace" aria-labelledby="workspace-title">
          <header className="workspace__header">
            <div>
              <p className="eyebrow">VÝZKUMNÝ PROSTOR</p>
              <h1 id="workspace-title">{company}</h1>
              <p>
                Než se z kandidáta stane kontakt, musí mít veřejný zdroj,
                konkrétní důkaz a vysvětlenou nejistotu.
              </p>
            </div>
            <button className="quiet-button" type="button" onClick={reset}>
              Změnit firmu
            </button>
          </header>
          <section className="company-profile" aria-labelledby="profile-title">
            <div>
              <p className="eyebrow">VEŘEJNÝ PROFIL WEBU</p>
              <h2 id="profile-title">
                {profile?.siteName || profile?.title || company}
              </h2>
              {profile?.description ? (
                <p className="company-profile__description">
                  {profile.description}
                </p>
              ) : (
                <p className="company-profile__description">
                  Web neposkytl použitelný veřejný popis nabídky.
                </p>
              )}
              {profile?.headings.length ? (
                <ul
                  className="profile-headings"
                  aria-label="Hlavní témata webu"
                >
                  {profile.headings.map((heading) => (
                    <li key={heading}>{heading}</li>
                  ))}
                </ul>
              ) : null}
              {profileError && (
                <p className="profile-warning" role="status">
                  {profileError}
                </p>
              )}
            </div>
            {profile && (
              <dl>
                <div>
                  <dt>Zdroj</dt>
                  <dd>
                    <a
                      href={profile.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {hostname(profile.sourceUrl)}{" "}
                      <span aria-hidden="true">↗</span>
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>Jazyk</dt>
                  <dd>{profile.language?.toUpperCase() || "Neurčen"}</dd>
                </div>
                <div>
                  <dt>Načteno</dt>
                  <dd>
                    {new Intl.DateTimeFormat("cs-CZ", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(profile.fetchedAt))}
                  </dd>
                </div>
              </dl>
            )}
          </section>
          <div className="research-notice" role="status">
            <span aria-hidden="true">●</span>
            <p>
              <strong>Pilotní veřejný zdroj GitHub Issues je připojený.</strong>{" "}
              Výsledky jsou pouze nízko-jistotní návrhy. Do ověřovací fronty je
              musí převzít člověk a teprve potom ručně potvrdit nebo zamítnout.
            </p>
          </div>
          <section className="discovery" aria-labelledby="discovery-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">VEŘEJNÝ ZDROJ · GITHUB ISSUES</p>
                <h2 id="discovery-title">Najít čerstvé veřejné návrhy</h2>
              </div>
              {discoveryRuns[0] && (
                <span className="run-meta">
                  Poslední běh: {discoveryRuns[0].totalFound} návrhů
                </span>
              )}
            </div>
            <form className="discovery-form" onSubmit={runDiscovery}>
              <label htmlFor="discovery-query">Konkrétní téma nabídky</label>
              <div>
                <input
                  id="discovery-query"
                  value={discoveryQuery}
                  onChange={(event) => setDiscoveryQuery(event.target.value)}
                  minLength={3}
                  maxLength={120}
                  placeholder="např. customer portal nebo warehouse automation"
                />
                <button type="submit" disabled={isDiscovering}>
                  {isDiscovering ? "Hledám…" : "Prohledat veřejné issues"}
                </button>
              </div>
              <p>
                Prohledávají se jen otevřené issues z posledních 45 dní.
                Výsledek ještě není lead ani potvrzená poptávka.
              </p>
            </form>
            {discoveryError && (
              <p className="form-error" role="alert">
                {discoveryError}
              </p>
            )}
            {discoveryRuns[0] && (
              <div className="candidate-list" aria-live="polite">
                {discoveryRuns[0].candidates.length ? (
                  discoveryRuns[0].candidates.map((candidate) => (
                    <article
                      className="candidate-card"
                      key={candidate.externalId}
                    >
                      <div>
                        <span>Návrh · nízká jistota</span>
                        <h3>{candidate.sourceName}</h3>
                        <p>{candidate.evidence}</p>
                        <a
                          href={candidate.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Otevřít veřejný zdroj ↗
                        </a>
                      </div>
                      <button
                        type="button"
                        disabled={importingCandidateId === candidate.externalId}
                        onClick={() =>
                          void importCandidate(discoveryRuns[0].id, candidate)
                        }
                      >
                        {importingCandidateId === candidate.externalId
                          ? "Přebírám…"
                          : "Převzít k ověření"}
                      </button>
                    </article>
                  ))
                ) : (
                  <p className="discovery-empty">
                    Tento běh nenašel žádný čerstvý veřejný návrh. Nula je
                    poctivý výsledek — zkuste přesnější anglické téma.
                  </p>
                )}
              </div>
            )}
          </section>
          <section className="signals" aria-labelledby="signals-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">OVĚŘOVACÍ FRONTA</p>
                <h2 id="signals-title">
                  {signals.length
                    ? candidateLabel(signals.length)
                    : "Zatím žádný doložený kandidát"}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowEvidenceForm((visible) => !visible)}
              >
                {showEvidenceForm ? "Zavřít formulář" : "Přidat veřejný důkaz"}{" "}
                <span aria-hidden="true">+</span>
              </button>
            </div>
            {showEvidenceForm && (
              <form className="evidence-form" onSubmit={addEvidence} noValidate>
                <div className="form-grid">
                  <label>
                    Název zdroje
                    <input
                      name="sourceName"
                      placeholder="Např. veřejná poptávka / příspěvek firmy"
                    />
                  </label>
                  <label>
                    Adresa veřejného zdroje
                    <input
                      name="sourceUrl"
                      type="url"
                      placeholder="https://…"
                      required
                    />
                  </label>
                  <label>
                    Datum zveřejnění nebo ověření
                    <input
                      name="observedAt"
                      type="date"
                      defaultValue={new Date().toISOString().slice(0, 10)}
                      required
                    />
                  </label>
                  <label>
                    Jistota
                    <select name="confidence" defaultValue="MEDIUM">
                      <option value="LOW">Nízká</option>
                      <option value="MEDIUM">Střední</option>
                      <option value="HIGH">Vysoká</option>
                    </select>
                  </label>
                </div>
                <label>
                  Konkrétní důkaz
                  <textarea
                    name="evidence"
                    rows={3}
                    placeholder="Citace nebo přesné shrnutí toho, co zdroj veřejně říká."
                    required
                  />
                </label>
                <label>
                  Proč se to hodí právě této firmě
                  <textarea
                    name="match"
                    rows={3}
                    placeholder="Napojení na nabídku firmy, ne obecná domněnka."
                    required
                  />
                </label>
                <label>
                  Co ještě nevíme
                  <textarea
                    name="uncertainty"
                    rows={2}
                    placeholder="Např. zda je požadavek aktuální nebo kdo rozhoduje."
                  />
                </label>
                {formError && (
                  <p className="form-error" role="alert">
                    {formError}
                  </p>
                )}
                <div className="evidence-form__actions">
                  <button type="submit" disabled={isSaving}>
                    {isSaving ? "Ukládám…" : "Uložit doložený kandidát"}
                  </button>
                  <span>Uloží se přes API; žádné oslovení se nevytváří.</span>
                </div>
              </form>
            )}
            {signals.length > 0 ? (
              <div className="signal-list">
                {reviewError && (
                  <p className="form-error" role="alert">
                    {reviewError}
                  </p>
                )}
                {signals.map((signal) => (
                  <SignalCard
                    signal={signal}
                    key={signal.id}
                    isReviewing={reviewingId === signal.id}
                    onReview={reviewSignal}
                  />
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <span aria-hidden="true">⌁</span>
                <h3>Nejdřív důkaz, potom kontakt.</h3>
                <p>
                  Vlož odkaz na veřejný zdroj. Bez zdroje a bez uvedené
                  nejistoty DealSignal nesmí tvrdit, že existuje obchodní
                  příležitost.
                </p>
              </div>
            )}
          </section>
          <section className="format-preview" aria-labelledby="format-title">
            <div>
              <p className="eyebrow">JAK VYPADÁ VÝSTUP</p>
              <h2 id="format-title">Jeden signál musí obstát sám o sobě.</h2>
              <p>Ukázka níže je šablona, ne výsledek pro {company}.</p>
            </div>
            <SignalCard signal={exampleSignal} isExample />
          </section>
        </section>
      )}
    </main>
  );
}

export default App;
