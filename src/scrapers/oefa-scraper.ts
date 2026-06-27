/**
 * Scraper for OEFA Tribunal de Fiscalización Ambiental.
 *
 * Site: https://publico.oefa.gob.pe/repdig/consulta/consultaTfa.xhtml
 * Stack: JSF (Mojarra) + PrimeFaces 6.0
 *
 * Flow:
 * 1. GET the page → JSESSIONID cookie + javax.faces.ViewState
 * 2. POST search (empty = all) via PrimeFaces AJAX → first page + total count
 * 3. Parse DataTable rows from CDATA in the AJAX XML response
 * 4. Paginate via PrimeFaces DataTable pagination AJAX requests
 * 5. Download PDFs via mojarra.jsfcljs form POST (buttonId + param_uuid per row)
 */

import * as cheerio from "cheerio";
import * as path from "path";
import { HttpClient } from "../utils/http-client";
import { logger } from "../utils/logger";
import { saveFile, saveJson, sanitizeFilename, ensureDir, appendLine, loadJson } from "../utils/file-utils";
import { ScrapedDocument, PdfDownloadInfo, ScrapeProgress, ScraperConfig } from "../types";

const CTX = "OefaScraper";
const BASE_URL = "https://publico.oefa.gob.pe";
const PAGE_PATH = "/repdig/consulta/consultaTfa.xhtml";
const FORM_ID = "listarDetalleInfraccionRAAForm";
const DT_ID = `${FORM_ID}:dt`;
const ROWS_PER_PAGE = 10;

export class OefaScraper {
  private http: HttpClient;
  private viewState = "";
  private documents: ScrapedDocument[] = [];
  private config: ScraperConfig;
  private progressFile: string;

  /** Last AJAX response — reused to parse data without re-fetching */
  private lastAjaxResponse = "";

  /**
   * Internal map: document index → PDF download metadata.
   * Kept separate so it never leaks into the output JSON.
   */
  private pdfInfoMap = new Map<number, PdfDownloadInfo>();

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

    const prevProgress = loadJson<ScrapeProgress>(this.progressFile);
    const startPage = prevProgress ? prevProgress.lastCompletedPage + 1 : 0;
    if (prevProgress) {
      logger.info(CTX, `Resuming from page ${startPage} (${prevProgress.documentsScraped} docs already scraped)`);
    }

    // Step 1: Initialize session
    await this.initSession();

    // Step 2: Search — also populates lastAjaxResponse with page 0
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
        if (page > 0) {
          await this.navigateToPage(page);
        }

        let pageDocuments = this.parseDataTable(this.lastAjaxResponse, page);

        // Trim to max-documents limit
        if (this.config.maxDocuments > 0) {
          const remaining = this.config.maxDocuments - this.documents.length;
          if (remaining <= 0) break;
          pageDocuments = pageDocuments.slice(0, remaining);
        }

        this.documents.push(...pageDocuments);

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

    const outputFile = saveJson(this.config.outputDir, "oefa-documents.json", this.documents);
    logger.info(CTX, `Scraping complete. ${this.documents.length} documents saved to ${outputFile}`);
    return this.documents;
  }

  // ---------------------------------------------------------------------------
  // Session management
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

  /**
   * After a non-AJAX POST (PDF download) the JSF ViewState is invalidated.
   * Also handles ViewState expiration during long scraping sessions.
   * Re-GETs the page and re-triggers search to restore full state.
   */
  private async restoreSession(): Promise<void> {
    logger.debug(CTX, "Restoring JSF session...");

    const response = await this.http.get(PAGE_PATH);
    if (response.status === 200) {
      const newVS = this.extractViewState(response.data as string);
      if (newVS) {
        this.viewState = newVS;
      } else {
        logger.warn(CTX, "Could not extract ViewState during session restore");
      }
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
  // Search
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
  // Pagination
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

    // Search response wraps DataTable inside pgLista; pagination returns it directly
    let html = this.extractCdataContent(xml, `${FORM_ID}:pgLista`);
    if (!html) {
      html = this.extractCdataContent(xml, DT_ID);
    }
    if (!html) {
      logger.warn(CTX, `No DataTable content found for page ${pageNum}`);
      return documents;
    }

    // Pagination returns bare <tr> elements. Cheerio drops <tr>/<td> outside a
    // <table>, so we wrap when the CDATA starts with <tr.
    const wrappedHtml = html.trimStart().startsWith("<tr")
      ? `<table><tbody>${html}</tbody></table>`
      : html;

    const $ = cheerio.load(wrappedHtml);

    $("tr[data-ri]").each((_i, row) => {
      const cells = $(row).find("td");
      if (cells.length < 7) return;

      const index = parseInt($(cells[0]).text().trim(), 10) || 0;
      const expediente = $(cells[1]).text().trim();
      const administrado = $(cells[2]).text().trim();
      const unidadFiscalizable = $(cells[3]).text().trim();
      const sector = $(cells[4]).text().trim();
      const nroResolucion = $(cells[5]).text().trim();

      // Extract PDF download metadata from onclick and store separately
      const archiveCell = $(cells[6]);
      const pdfInfo = this.extractPdfInfo(archiveCell);
      const hasPdf = pdfInfo !== null;

      if (pdfInfo) {
        this.pdfInfoMap.set(index, pdfInfo);
      }

      documents.push({
        index,
        expediente,
        administrado,
        unidadFiscalizable,
        sector,
        nroResolucion,
        hasPdf,
        pdfDownloaded: false,
        pdfFilename: null,
        error: null,
      });
    });

    logger.debug(CTX, `Extracted ${documents.length} documents from page ${pageNum}`);
    return documents;
  }

  /**
   * Parses the onclick handler of a PDF link to extract the JSF command button
   * ID and the document UUID.
   *
   * onclick pattern:
   *   mojarra.jsfcljs(form, {'form:dt:N:j_idtXX':'...', 'param_uuid':'UUID'}, '')
   */
  private extractPdfInfo(
    cell: ReturnType<cheerio.CheerioAPI>,
  ): PdfDownloadInfo | null {
    const link = cell.find("a");
    if (link.length === 0) return null;

    const onclick = link.attr("onclick") || "";
    const buttonMatch = onclick.match(/'(listarDetalleInfraccionRAAForm:dt:\d+:j_idt\d+)'/);
    const uuidMatch = onclick.match(/param_uuid':'([a-f0-9-]+)'/);

    if (buttonMatch && uuidMatch) {
      return { buttonId: buttonMatch[1], uuid: uuidMatch[1] };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // PDF Downloads
  // ---------------------------------------------------------------------------

  private async downloadPagePdfs(documents: ScrapedDocument[]): Promise<void> {
    const pdfDir = path.join(this.config.outputDir, "pdfs");
    ensureDir(pdfDir);

    for (const doc of documents) {
      const pdfInfo = this.pdfInfoMap.get(doc.index);
      if (!pdfInfo) {
        logger.debug(CTX, `No PDF available for doc ${doc.index} (${doc.expediente})`);
        continue;
      }

      try {
        const filename = sanitizeFilename(
          `${doc.expediente}_${doc.nroResolucion}`.replace(/\//g, "-"),
        ) + ".pdf";

        logger.debug(CTX, `Downloading PDF: ${filename}`);

        // mojarra.jsfcljs submits a regular (non-AJAX) form POST
        const formData = this.buildFormFields();
        formData.append(pdfInfo.buttonId, pdfInfo.buttonId);
        formData.append("param_uuid", pdfInfo.uuid);

        const response = await this.http.post(PAGE_PATH, formData.toString(), {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: `${BASE_URL}${PAGE_PATH}`,
          },
          responseType: "arraybuffer",
        });

        if (response.status === 200) {
          const data = Buffer.from(response.data as ArrayBuffer);

          // Verify response is actually a PDF (%PDF magic bytes)
          if (data.length > 4 && data.slice(0, 4).toString("ascii") === "%PDF") {
            saveFile(pdfDir, filename, data);
            doc.pdfDownloaded = true;
            doc.pdfFilename = filename;
            logger.info(CTX, `Downloaded: ${filename} (${(data.length / 1024).toFixed(0)} KB)`);
          } else {
            // Could be an HTML error page or expired session redirect
            throw new Error("Response is not a PDF (missing %PDF header)");
          }
        } else {
          throw new Error(`HTTP ${response.status}`);
        }

        // Non-AJAX POST invalidates JSF ViewState — must restore
        await this.restoreSession();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        doc.error = msg;
        doc.pdfDownloaded = false;

        appendLine(
          path.join(this.config.outputDir, "failed-downloads.txt"),
          `${new Date().toISOString()} | ${doc.expediente} | ${doc.nroResolucion} | ${msg}`,
        );

        logger.error(CTX, `Failed to download PDF for ${doc.expediente}: ${msg}`);

        // Try to restore session even after failure
        try {
          await this.restoreSession();
        } catch {
          logger.warn(CTX, "Could not restore session after download failure");
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Common helpers
  // ---------------------------------------------------------------------------

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

    // Detect expired session: server returns a redirect or empty response
    if (xml.includes("ViewExpiredException") || xml.includes("session") || xml.length < 100) {
      logger.warn(CTX, "ViewState expired — re-initializing session...");
      await this.initSession();
      // Retry the request with fresh ViewState
      formData.set("javax.faces.ViewState", this.viewState);
      const retryRes = await this.http.post(PAGE_PATH, formData.toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Faces-Request": "partial/ajax",
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${BASE_URL}${PAGE_PATH}`,
        },
      });
      const retryXml = retryRes.data as string;
      this.updateViewStateFromAjax(retryXml);
      return retryXml;
    }

    this.updateViewStateFromAjax(xml);
    return xml;
  }

  // ---------------------------------------------------------------------------
  // JSF helpers
  // ---------------------------------------------------------------------------

  private extractViewState(html: string): string {
    const match = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/);
    return match ? match[1] : "";
  }

  private updateViewStateFromAjax(xml: string): void {
    const match = xml.match(
      /<update\s+id="j_id1:javax\.faces\.ViewState:0"[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/update>/,
    );
    if (match) { this.viewState = match[1]; return; }

    const alt = xml.match(
      /<update\s+id="javax\.faces\.ViewState"[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/update>/,
    );
    if (alt) { this.viewState = alt[1]; }
  }

  private extractCdataContent(xml: string, elementId: string): string | null {
    const escaped = elementId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `<update\\s+id="${escaped}"[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/update>`,
    );
    const match = xml.match(regex);
    return match ? match[1] : null;
  }

  private parsePaginatorInfo(xml: string): { totalRecords: number; totalPages: number } {
    const match = xml.match(/P[aá]gina\s+\d+\s+de\s+(\d+)\s+\((\d+)\s+registros?\)/);
    if (match) {
      return {
        totalPages: parseInt(match[1], 10),
        totalRecords: parseInt(match[2], 10),
      };
    }

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
