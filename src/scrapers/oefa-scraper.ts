/**
 * Scraper for OEFA Tribunal de Fiscalización Ambiental.
 *
 * Site: https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml
 * Stack: JSF (Mojarra) + PrimeFaces 6.0
 *
 * How it works:
 * 1. GET the page → JSESSIONID cookie + javax.faces.ViewState
 * 2. POST search (empty = all) via PrimeFaces AJAX → get first page + total count
 * 3. Parse DataTable rows from CDATA in the AJAX XML response
 * 4. Paginate via PrimeFaces DataTable pagination AJAX requests
 * 5. Download PDFs via mojarra.jsfcljs form POST (buttonId + param_uuid per row)
 */

import * as cheerio from "cheerio";
import * as path from "path";
import { HttpClient } from "../utils/http-client";
import { logger } from "../utils/logger";
import { saveFile, saveJson, sanitizeFilename, ensureDir, appendLine, loadJson } from "../utils/file-utils";
import { ScrapedDocument, ScrapeProgress, ScraperConfig } from "../types";

const CTX = "OefaScraper";
const BASE_URL = "https://publico.oefa.gob.pe";
const PAGE_PATH = "/repdig/consulta/consultaTfa.xhtml";
const FORM_ID = "listarDetalleInfraccionRAAForm";
const DT_ID = `${FORM_ID}:dt`;
const ROWS_PER_PAGE = 10;

/** Data extracted from each row needed to download the PDF */
interface RowPdfInfo {
  /** e.g. "listarDetalleInfraccionRAAForm:dt:0:j_idt63" */
  buttonId: string;
  /** UUID passed as param_uuid */
  uuid: string;
}

export class OefaScraper {
  private http: HttpClient;
  private viewState = "";
  private documents: ScrapedDocument[] = [];
  private config: ScraperConfig;
  private progressFile: string;
  /** Last AJAX response XML — used to parse data without re-fetching */
  private lastAjaxResponse = "";

  constructor(config: ScraperConfig) {
    this.config = config;
    this.http = new HttpClient({
      baseUrl: BASE_URL,
      requestDelay: config.requestDelay,
      maxRetries: config.maxRetries,
    });
    this.progressFile = path.join(config.outputDir, "progress-oefa.json");
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------

  async scrape(): Promise<ScrapedDocument[]> {
    logger.info(CTX, "Starting OEFA scraper...");
    ensureDir(this.config.outputDir);

    // Load previous progress if exists
    const prevProgress = loadJson<ScrapeProgress>(this.progressFile);
    const startPage = prevProgress ? prevProgress.lastCompletedPage + 1 : 0;
    if (prevProgress) {
      logger.info(CTX, `Resuming from page ${startPage} (${prevProgress.documentsScraped} docs already scraped)`);
    }

    // Step 1: Initialize session
    await this.initSession();

    // Step 2: Trigger search (empty = all results) — also returns page 0 data
    const { totalRecords, totalPages } = await this.triggerSearch();
    logger.info(CTX, `Found ${totalRecords} records across ${totalPages} pages`);

    if (totalRecords === 0) {
      logger.warn(CTX, "No records found. The site might be down or the structure changed.");
      return [];
    }

    // Step 3: Iterate pages
    const maxPages = this.config.maxDocuments > 0
      ? Math.ceil(this.config.maxDocuments / ROWS_PER_PAGE)
      : totalPages;
    const endPage = Math.min(totalPages, maxPages);

    for (let page = startPage; page < endPage; page++) {
      try {
        // Page 0 data is already in lastAjaxResponse from triggerSearch
        if (page > 0) {
          await this.navigateToPage(page);
        }

        // Parse rows from the stored AJAX response
        let pageDocuments = this.parseDataTable(this.lastAjaxResponse, page);

        // Trim to max documents limit
        if (this.config.maxDocuments > 0) {
          const remaining = this.config.maxDocuments - this.documents.length;
          if (remaining <= 0) break;
          pageDocuments = pageDocuments.slice(0, remaining);
        }

        this.documents.push(...pageDocuments);

        // Download PDFs for this page
        if (this.config.downloadPdfs) {
          await this.downloadPagePdfs(pageDocuments);
        }

        this.saveProgress(page, totalPages, totalRecords);
        logger.progress(CTX, page + 1, endPage, "Page scraped");

        if (this.config.maxDocuments > 0 && this.documents.length >= this.config.maxDocuments) {
          logger.info(CTX, `Reached max documents limit (${this.config.maxDocuments})`);
          break;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(CTX, `Error on page ${page}: ${msg}`);
      }
    }

    // Save final results
    const outputFile = saveJson(this.config.outputDir, "oefa-documents.json", this.documents);
    logger.info(CTX, `Scraping complete. ${this.documents.length} documents saved to ${outputFile}`);

    return this.documents;
  }

  // ---------------------------------------------------------------------------
  // Session initialization
  // ---------------------------------------------------------------------------

  private async initSession(): Promise<void> {
    logger.info(CTX, "Initializing session...");

    const response = await this.http.get(PAGE_PATH);
    if (response.status !== 200) {
      throw new Error(`Failed to load page: HTTP ${response.status}`);
    }

    this.viewState = this.extractViewState(response.data as string);
    if (!this.viewState) {
      throw new Error("Could not extract ViewState from initial page load");
    }

    logger.info(CTX, `Session initialized. ViewState length: ${this.viewState.length}`);
  }

  // ---------------------------------------------------------------------------
  // Search trigger — returns page 0 data in lastAjaxResponse
  // ---------------------------------------------------------------------------

  private async triggerSearch(): Promise<{ totalRecords: number; totalPages: number }> {
    logger.info(CTX, "Triggering search (all records)...");

    const formData = this.buildFormFields();
    formData.append("javax.faces.partial.ajax", "true");
    formData.append("javax.faces.source", `${FORM_ID}:btnBuscar`);
    formData.append("javax.faces.partial.execute", "@all");
    formData.append("javax.faces.partial.render", `${FORM_ID}:pgLista ${FORM_ID}:txtNroexp`);
    formData.append(`${FORM_ID}:btnBuscar`, `${FORM_ID}:btnBuscar`);

    const xml = await this.postAjax(formData);
    this.lastAjaxResponse = xml;

    return this.parsePaginatorInfo(xml);
  }

  // ---------------------------------------------------------------------------
  // Pagination — stores response in lastAjaxResponse
  // ---------------------------------------------------------------------------

  private async navigateToPage(page: number): Promise<void> {
    logger.debug(CTX, `Navigating to page ${page}...`);

    const formData = this.buildFormFields();
    formData.append("javax.faces.partial.ajax", "true");
    formData.append("javax.faces.source", DT_ID);
    formData.append("javax.faces.partial.execute", DT_ID);
    formData.append("javax.faces.partial.render", DT_ID);
    formData.append(DT_ID, DT_ID);
    formData.append(`${DT_ID}_pagination`, "true");
    formData.append(`${DT_ID}_first`, String(page * ROWS_PER_PAGE));
    formData.append(`${DT_ID}_rows`, String(ROWS_PER_PAGE));
    formData.append(`${DT_ID}_encodeFeature`, "true");

    const xml = await this.postAjax(formData);
    this.lastAjaxResponse = xml;
  }

  // ---------------------------------------------------------------------------
  // Data extraction
  // ---------------------------------------------------------------------------

  private parseDataTable(xml: string, pageNum: number): ScrapedDocument[] {
    const documents: ScrapedDocument[] = [];

    // The search response wraps the DataTable inside pgLista span
    // The pagination response returns the DataTable directly
    let html = this.extractCdataContent(xml, `${FORM_ID}:pgLista`);
    if (!html) {
      html = this.extractCdataContent(xml, DT_ID);
    }
    if (!html) {
      logger.warn(CTX, `No DataTable content found in AJAX response for page ${pageNum}`);
      return documents;
    }

    // Pagination responses return bare <tr> elements without <table> wrapper.
    // Cheerio drops <tr>/<td> outside a <table>, so we wrap if needed.
    const wrappedHtml = html.trimStart().startsWith("<tr")
      ? `<table><tbody>${html}</tbody></table>`
      : html;

    const $ = cheerio.load(wrappedHtml);
    const rows = $("tr[data-ri]");

    rows.each((_i, row) => {
      const cells = $(row).find("td");
      if (cells.length < 7) return;

      const index = parseInt($(cells[0]).text().trim(), 10) || 0;
      const expediente = $(cells[1]).text().trim();
      const administrado = $(cells[2]).text().trim();
      const unidadFiscalizable = $(cells[3]).text().trim();
      const sector = $(cells[4]).text().trim();
      const nroResolucion = $(cells[5]).text().trim();

      // Extract PDF download info from onclick in the last column
      // Pattern: mojarra.jsfcljs(form, {'buttonId':'buttonId', 'param_uuid':'uuid'}, '')
      const archiveCell = $(cells[6]);
      const pdfInfo = this.extractPdfInfo(archiveCell, $);

      documents.push({
        index,
        expediente,
        administrado,
        unidadFiscalizable,
        sector,
        nroResolucion,
        pdfUrl: pdfInfo ? pdfInfo.uuid : null, // Store UUID as identifier
        pdfDownloaded: false,
        pdfLocalPath: null,
        error: null,
        // Store download info as internal metadata
        ...(pdfInfo && { _pdfButtonId: pdfInfo.buttonId, _pdfUuid: pdfInfo.uuid }),
      } as ScrapedDocument & { _pdfButtonId?: string; _pdfUuid?: string });
    });

    logger.debug(CTX, `Extracted ${documents.length} documents from page ${pageNum}`);
    return documents;
  }

  private extractPdfInfo(
    cell: ReturnType<cheerio.CheerioAPI>,
    $: cheerio.CheerioAPI,
  ): RowPdfInfo | null {
    const link = cell.find("a");
    if (link.length === 0) return null;

    const onclick = link.attr("onclick") || "";

    // Extract buttonId: 'listarDetalleInfraccionRAAForm:dt:N:j_idtXX'
    const buttonMatch = onclick.match(/'(listarDetalleInfraccionRAAForm:dt:\d+:j_idt\d+)'/);
    // Extract UUID: 'param_uuid':'xxxx-xxxx-xxxx'
    const uuidMatch = onclick.match(/param_uuid':'([a-f0-9-]+)'/);

    if (buttonMatch && uuidMatch) {
      return { buttonId: buttonMatch[1], uuid: uuidMatch[1] };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // PDF Downloads — via mojarra.jsfcljs form POST
  // ---------------------------------------------------------------------------

  private async downloadPagePdfs(
    documents: Array<ScrapedDocument & { _pdfButtonId?: string; _pdfUuid?: string }>,
  ): Promise<void> {
    const pdfDir = path.join(this.config.outputDir, "pdfs");
    ensureDir(pdfDir);

    for (const doc of documents) {
      if (!doc._pdfButtonId || !doc._pdfUuid) {
        logger.debug(CTX, `No PDF download info for doc ${doc.index} (${doc.expediente})`);
        continue;
      }

      try {
        const filename = sanitizeFilename(
          `${doc.expediente}_${doc.nroResolucion}`.replace(/\//g, "-"),
        ) + ".pdf";

        logger.debug(CTX, `Downloading PDF: ${filename} (uuid: ${doc._pdfUuid})`);

        // mojarra.jsfcljs submits a regular (non-AJAX) form POST
        const formData = this.buildFormFields();
        formData.append(doc._pdfButtonId, doc._pdfButtonId);
        formData.append("param_uuid", doc._pdfUuid);

        const response = await this.http.post(PAGE_PATH, formData.toString(), {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: `${BASE_URL}${PAGE_PATH}`,
          },
          responseType: "arraybuffer",
        });

        if (response.status === 200) {
          const data = Buffer.from(response.data as ArrayBuffer);

          // Verify it's actually a PDF
          if (data.length > 4 && data.slice(0, 4).toString("ascii") === "%PDF") {
            const savedPath = saveFile(pdfDir, filename, data);
            doc.pdfDownloaded = true;
            doc.pdfLocalPath = savedPath;
            logger.info(CTX, `Downloaded: ${filename} (${(data.length / 1024).toFixed(0)} KB)`);
          } else {
            throw new Error("Response is not a PDF file");
          }
        } else {
          throw new Error(`HTTP ${response.status}`);
        }

        // After a PDF download (non-AJAX POST), the ViewState changes.
        // We need to re-initialize the session for subsequent downloads.
        await this.reinitSession();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        doc.error = msg;
        doc.pdfDownloaded = false;

        appendLine(
          path.join(this.config.outputDir, "failed-downloads.txt"),
          `${new Date().toISOString()} | ${doc.expediente} | uuid:${doc._pdfUuid} | ${msg}`,
        );

        logger.error(CTX, `Failed to download PDF for ${doc.expediente}: ${msg}`);
      }
    }
  }

  /**
   * After a non-AJAX form POST (PDF download), the JSF state is invalidated.
   * Re-GET the page and re-trigger search to restore session state.
   */
  private async reinitSession(): Promise<void> {
    const response = await this.http.get(PAGE_PATH);
    if (response.status === 200) {
      this.viewState = this.extractViewState(response.data as string);
    }

    // Re-trigger search to restore DataTable state
    const formData = this.buildFormFields();
    formData.append("javax.faces.partial.ajax", "true");
    formData.append("javax.faces.source", `${FORM_ID}:btnBuscar`);
    formData.append("javax.faces.partial.execute", "@all");
    formData.append("javax.faces.partial.render", `${FORM_ID}:pgLista ${FORM_ID}:txtNroexp`);
    formData.append(`${FORM_ID}:btnBuscar`, `${FORM_ID}:btnBuscar`);

    const xml = await this.postAjax(formData);
    this.lastAjaxResponse = xml;
  }

  // ---------------------------------------------------------------------------
  // Common helpers
  // ---------------------------------------------------------------------------

  /** Build the base form fields that every request needs */
  private buildFormFields(): URLSearchParams {
    const params = new URLSearchParams();
    params.append(FORM_ID, FORM_ID);
    params.append(`${FORM_ID}:txtNroexp`, "");
    params.append(`${FORM_ID}:j_idt21`, "");
    params.append(`${FORM_ID}:j_idt25`, "");
    params.append(`${FORM_ID}:idsector`, "");
    params.append(`${FORM_ID}:j_idt34`, "");
    params.append(`${FORM_ID}:dt_scrollState`, "0,0");
    params.append("javax.faces.ViewState", this.viewState);
    return params;
  }

  /** POST an AJAX request and update ViewState from response */
  private async postAjax(formData: URLSearchParams): Promise<string> {
    const response = await this.http.post(PAGE_PATH, formData.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Faces-Request": "partial/ajax",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${BASE_URL}${PAGE_PATH}`,
      },
    });

    const xml = response.data as string;
    this.updateViewStateFromAjax(xml);
    return xml;
  }

  // ---------------------------------------------------------------------------
  // JSF/PrimeFaces helpers
  // ---------------------------------------------------------------------------

  private extractViewState(html: string): string {
    const match = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/);
    return match ? match[1] : "";
  }

  private updateViewStateFromAjax(xml: string): void {
    const match = xml.match(
      /<update\s+id="j_id1:javax\.faces\.ViewState:0"[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/update>/,
    );

    if (match) {
      this.viewState = match[1];
      return;
    }

    const alt = xml.match(
      /<update\s+id="javax\.faces\.ViewState"[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/update>/,
    );

    if (alt) {
      this.viewState = alt[1];
    }
  }

  private extractCdataContent(xml: string, elementId: string): string | null {
    // Try the ID as-is (colons are literal in the XML)
    const escaped = this.escapeRegex(elementId);
    const regex = new RegExp(
      `<update\\s+id="${escaped}"[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/update>`,
    );
    const match = xml.match(regex);
    return match ? match[1] : null;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private parsePaginatorInfo(xml: string): { totalRecords: number; totalPages: number } {
    // Pattern: "Página 1 de 176 (1753 registros)"
    const match = xml.match(/P[aá]gina\s+\d+\s+de\s+(\d+)\s+\((\d+)\s+registros?\)/);
    if (match) {
      return {
        totalPages: parseInt(match[1], 10),
        totalRecords: parseInt(match[2], 10),
      };
    }

    // Fallback: PrimeFaces widget config
    const rowCountMatch = xml.match(/rowCount:(\d+)/);
    if (rowCountMatch) {
      const total = parseInt(rowCountMatch[1], 10);
      return { totalRecords: total, totalPages: Math.ceil(total / ROWS_PER_PAGE) };
    }

    return { totalRecords: 0, totalPages: 0 };
  }

  // ---------------------------------------------------------------------------
  // Progress tracking
  // ---------------------------------------------------------------------------

  private saveProgress(page: number, totalPages: number, totalRecords: number): void {
    const progress: ScrapeProgress = {
      site: "oefa",
      totalPages,
      lastCompletedPage: page,
      totalDocuments: totalRecords,
      documentsScraped: this.documents.length,
      documentsDownloaded: this.documents.filter((d) => d.pdfDownloaded).length,
      failedDownloads: this.documents.filter((d) => d.error).map((d) => d.expediente),
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    };

    saveJson(this.config.outputDir, "progress-oefa.json", progress);
  }
}
