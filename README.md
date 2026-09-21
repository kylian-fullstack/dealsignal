# DealSignal

> Vložte web firmy a vytvořte auditovatelný seznam veřejných signálů, kdo může právě potřebovat její nabídku.

DealSignal není generický AI audit ani koupená databáze kontaktů. Každý kandidát musí mít veřejný zdroj, datum pozorování, konkrétní důkaz, vysvětlení shody a přiznanou nejistotu. Aplikace záměrně neprezentuje vymyšlená data jako obchodní příležitosti.

## Co už funguje

- React + TypeScript rozhraní nad skutečným verzovaným REST API,
- založení pracovního prostoru z URL a serverová JSON perzistence,
- bezpečné načtení veřejných metadat cílového webu,
- pilotní konektor veřejných GitHub Issues s konzervativním filtrem komerčního úmyslu,
- uložené discovery běhy a serverové převzetí návrhu se zachováním provenience,
- ruční vložení a stránkovaný výpis doložených signálů,
- lidské schválení nebo zamítnutí s poznámkou a auditní stopou,
- optimistická kontrola verze bránící tichému přepsání souběžné změny,
- idempotentní zápisy chránící před dvojím vytvořením signálu,
- strukturované validační a doménové chyby,
- bezpečnostní HTTP hlavičky, limity payloadu a SSRF ochrana,
- jednotkové a integrační testy API, klienta, perzistence i profileru,
- opakovatelná lokální kontrola formátu, typů, lintu, testů, buildu a závislostí;
  připravená definice GitHub Actions je v `docs/ci-workflow.yml` a čeká na účet s oprávněním `workflow`.

## Architektura

```text
React klient ── /api/v1 ── Express API ── FileStore ── data/store.json
                              │
                              ├── WebsiteProfiler
                              │   DNS validace → připnutá veřejná IP → HTML metadata
                              │
                              └── GitHubIssueConnector
                                  veřejné API → přesnostní filtry → návrhy k ověření
```

`WebsiteProfiler` přijímá pouze HTTPS URL bez přihlašovacích údajů a nestandardního portu. Před připojením ověří všechny DNS odpovědi a odmítne privátní, lokální, rezervované i jinak neveřejné adresy. HTTP klient poté použije ověřenou připnutou adresu, zakáže přesměrování a omezuje čas i velikost odpovědi. Tím brání DNS rebindingu a přístupu do interní sítě.

## Lokální vývoj

Požadavky: Node.js 24 a npm.

```bash
npm ci --ignore-scripts
npm run dev
```

Web poběží na `http://localhost:5173`, API na `http://127.0.0.1:8787`. Vite při vývoji proxyuje `/api` na API server.

## Kontroly kvality

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

Po sestavení lze frontend a API spustit jedním procesem:

```bash
npm run build
npm start
```

## API

| Metoda  | Cesta                                                                        | Účel                                    |
| ------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| `GET`   | `/api/v1/health`                                                             | Kontrola dostupnosti                    |
| `POST`  | `/api/v1/workspaces`                                                         | Založení nebo načtení prostoru pro web  |
| `PUT`   | `/api/v1/workspaces/:id/profile`                                             | Bezpečné načtení veřejného profilu webu |
| `POST`  | `/api/v1/workspaces/:id/discovery-runs`                                      | Spuštění a uložení veřejného hledání    |
| `GET`   | `/api/v1/workspaces/:id/discovery-runs`                                      | Historie veřejných hledání              |
| `POST`  | `/api/v1/workspaces/:id/discovery-runs/:runId/candidates/:externalId/import` | Serverové převzetí návrhu               |
| `GET`   | `/api/v1/workspaces/:id/signals`                                             | Stránkovaný výpis signálů               |
| `POST`  | `/api/v1/workspaces/:id/signals`                                             | Uložení doloženého signálu              |
| `PATCH` | `/api/v1/workspaces/:id/signals/:signalId/review`                            | Ruční rozhodnutí s kontrolou verze      |
| `GET`   | `/api/v1/workspaces/:id/signals/:signalId/audit`                             | Auditní historie rozhodnutí             |

Zápis signálu vyžaduje hlavičku `Idempotency-Key` o délce 8 až 128 znaků. Opakování stejného požadavku vrátí původní záznam; stejné ID s jiným tělem skončí řízenou chybou.

Nový signál má stav `PENDING_REVIEW` a verzi `1`. Rozhodnutí `VERIFIED` nebo `REJECTED` musí uvést očekávanou verzi a kontrolní poznámku. Zastaralý zápis vrátí `409 VERSION_CONFLICT`; úspěšná změna zvýší verzi a přidá neměnnou auditní událost.

GitHub návrh nelze poslat klientem jako libovolně změněná data. Importní endpoint načte kandidáta z uloženého běhu a vytvoří signál s původem `DISCOVERY`, ID běhu, konektorem a externím ID. Opakovaný import je idempotentní.

## Poctivé hranice současné verze

- Připojený je zatím jen pilotní GitHub Issues konektor; nejde o obecné prohledávání webu.
- Konektor záměrně odmítá komunitní příspěvky, dobrovolnictví, hromadné agregace a interní technické úkoly bez komerčního indikátoru. Často proto správně vrátí nulu.
- Neautentizované GitHub API má nízký limit dotazů a může dočasně vrátit `DISCOVERY_RATE_LIMITED`.
- FileStore je vhodný pro lokální demonstraci, ne pro více produkčních instancí.
- Aplikace zatím nemá účty, role ani týmový schvalovací proces.
- Žádný outreach se automaticky nepřipravuje ani neodesílá.
- Prostředí blokující přímé odchozí HTTPS spojení může zamezit profilování webu; ochrana se kvůli tomu neobchází.

Další produktový řez je katalog dalších povolených veřejných zdrojů se stejnou proveniencí, deduplikací a dohledatelnou transformací. Teprve po měření přesnosti na reálných webech dává smysl automatické řazení a schvalované oslovení.

## Technologie

React 19, TypeScript, Vite, Express, Zod, Undici, Cheerio, Helmet a Vitest.
