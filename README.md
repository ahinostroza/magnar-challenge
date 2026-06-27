# Scraper Challenge

TypeScript scraper for Peruvian legal documents. Extracts metadata and downloads PDFs from government judicial/environmental sites using raw HTTP requests (no browser automation).

## Sites Supported

| Site | URL | VPN Required |
|------|-----|:------------:|
| **OEFA** (Tribunal de Fiscalizacion Ambiental) | `publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml` | No |
| **PJ** (Jurisprudencia Nacional) | `jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml` | Yes (Peru) |

## Tech Stack

- **TypeScript** — strict mode
- **axios** — HTTP requests with cookie/session management
- **cheerio** — HTML parsing (no browser needed)
- Zero browser automation (no Puppeteer/Playwright/Selenium)

## Installation

```bash
git clone <repo-url>
cd scraper-challenge
npm install
```

## Usage

```bash
# Scrape OEFA (default, no VPN needed)
npm start

# Scrape OEFA explicitly
npm run start:oefa

# Scrape PJ (requires VPN to Peru)
npm run start:pj

# Dry run — metadata only, no PDF downloads
npm run start:dry
```

### CLI Options

```
ts-node src/index.ts [options]

--site <oefa|pj>   Site to scrape (default: oefa)
--max <number>      Max documents to scrape (default: 0 = all)
--delay <ms>        Delay between requests in ms (default: 1500)
--retries <number>  Max retries on 429/errors (default: 5)
--no-download       Skip PDF downloads (metadata only)
--dry-run           Same as --no-download
--verbose, -v       Enable debug logging
--help, -h          Show help
```

### Examples

```bash
# Scrape first 20 documents from OEFA
ts-node src/index.ts --site oefa --max 20

# Scrape PJ with longer delays and verbose logging
ts-node src/index.ts --site pj --delay 2000 --verbose

# Metadata only, no PDFs
ts-node src/index.ts --site oefa --dry-run
```

## Output

```
downloads/
  oefa/
    oefa-documents.json    # All scraped metadata
    progress-oefa.json     # Progress state (for resume)
    failed-downloads.txt   # Failed PDF downloads log
    pdfs/
      EXPEDIENTE_RESOLUCION.pdf
  pj/
    pj-documents.json
    progress-pj.json
    failed-downloads.txt
    pdfs/
      ...
```

## Project Structure

```
src/
  index.ts                  # CLI entry point
  types.ts                  # Shared TypeScript types
  scrapers/
    oefa-scraper.ts         # OEFA site scraper (PrimeFaces)
    pj-scraper.ts           # PJ Jurisprudencia scraper (RichFaces)
  utils/
    http-client.ts          # HTTP client with cookies, retry, backoff
    file-utils.ts           # File system helpers
    logger.ts               # Structured console logger
```

## Architecture

Both target sites use **JavaServer Faces (JSF)** with AJAX-powered server-side rendering:

- **OEFA** uses PrimeFaces 6.0
- **PJ** uses RichFaces 4.2.2

The scraper works by:

1. **Session init** — GET the page to capture the `JSESSIONID` cookie and `javax.faces.ViewState` token
2. **Search trigger** — POST a JSF AJAX request simulating the "Search" button click
3. **Pagination** — Send paginator AJAX requests (`_pagination=true`, `_first=N`) to navigate pages
4. **Data extraction** — Parse the HTML fragments returned in CDATA blocks of the AJAX XML response
5. **PDF download** — Follow extracted download URLs with the active session

### Error Handling (429)

- Detects HTTP 429 (Too Many Requests) responses
- Applies **exponential backoff** with ±20% jitter: `baseDelay * 2^attempt * random(0.8, 1.2)`
- Respects `Retry-After` header when present
- Configurable max retries (default: 5)
- Logs failed downloads to `failed-downloads.txt` for later retry
- Continues with next document on persistent failure

### Resumable Scraping

Progress is saved to `progress-{site}.json` after each page. If the scraper is interrupted, restarting it will resume from the last completed page.

## Build

```bash
# Type-check only
npm run lint

# Compile to JavaScript
npm run build
```
