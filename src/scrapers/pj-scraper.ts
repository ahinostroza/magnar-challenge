/**
 * Scraper for Jurisprudencia Nacional - Poder Judicial del Perú.
 *
 * Site: https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml
 * Stack: JSF + RichFaces 4.2.2
 *
 * How it works:
 * 1. GET the page to obtain JSESSIONID + javax.faces.ViewState
 * 2. POST a search via RichFaces AJAX (a4j:commandButton)
 * 3. Parse the result panel HTML
 * 4. Navigate via RichFaces DataScroller / pagination links
 * 5. Extract document details + PDF download links
 *
 * NOTE: This site requires a VPN to Peru. The code structure mirrors
 *       the OEFA scraper but adapts to RichFaces AJAX conventions.
 */

import * as cheerio from "cheerio";
import * as path from "path";
import { HttpClient } from "../utils/http-client";
import { logger } from "../utils/logger";
import { saveFile, saveJson, sanitizeFilename, ensureDir, appendLine, loadJson } from "../utils/file-utils";
import { PjDocument, ScrapeProgress, ScraperConfig } from "../types";

const CTX = "PjScraper";
const BASE_URL = "https://jurisprudencia.pj.gob.pe";
const PAGE_PATH = "/jurisprudenciaweb/faces/page/resultado.xhtml";
const FORM_ID = "formBuscador";

export class PjScraper {
  private http: HttpClient;
  private viewState = "";
  private documents: PjDocument[] = [];
  private config: ScraperConfig;
  private progressFile: string;

  constructor(config: ScraperConfig) {
    this.config = config;
    this.http = new HttpClient({
      baseUrl: BASE_URL,
      requestDelay: config.requestDelay,
      maxRetries: config.maxRetries,
      timeout: 45000, // PJ site can be slow
    });
    this.progressFile = path.join(config.outputDir, "progress-pj.json");
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------

  async scrape(): Promise<PjDocument[]> {
    logger.info(CTX, "Starting PJ Jurisprudencia scraper...");
    logger.info(CTX, "NOTE: This site requires a VPN connection to Peru.");
    ensureDir(this.config.outputDir);

    // Load previous progress
    const prevProgress = loadJson<ScrapeProgress>(this.progressFile);
    const startPage = prevProgress ? prevProgress.lastCompletedPage + 1 : 0;
    if (prevProgress) {
      logger.info(CTX, `Resuming from page ${startPage}`);
    }

    // Step 1: Initialize session
    await this.initSession();

    // Step 2: Trigger initial search
    const { totalRecords, totalPages } = await this.triggerSearch();
    logger.info(CTX, `Found ${totalRecords} records across ~${totalPages} pages`);

    if (totalRecords === 0) {
      logger.warn(CTX, "No records found. Check VPN connection or site availability.");
      return [];
    }

    // Step 3: Paginate and extract
    for (let page = startPage; page < totalPages; page++) {
      try {
        const pageDocuments = await this.scrapePage(page);
        this.documents.push(...pageDocuments);

        if (this.config.downloadPdfs) {
          await this.downloadPagePdfs(pageDocuments);
        }

        this.saveProgress(page, totalPages, totalRecords);
        logger.progress(CTX, page + 1, totalPages, "Page scraped");

        if (this.config.maxDocuments > 0 && this.documents.length >= this.config.maxDocuments) {
          logger.info(CTX, `Reached max documents limit (${this.config.maxDocuments})`);
          break;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(CTX, `Error on page ${page}: ${msg}`);
      }
    }

    const outputFile = saveJson(this.config.outputDir, "pj-documents.json", this.documents);
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

    const html = response.data as string;
    this.viewState = this.extractViewState(html);

    if (!this.viewState) {
      throw new Error("Could not extract ViewState from initial page load");
    }

    logger.info(CTX, `Session initialized. ViewState: ${this.viewState.substring(0, 30)}...`);
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  private async triggerSearch(): Promise<{ totalRecords: number; totalPages: number }> {
    logger.info(CTX, "Triggering search...");

    // RichFaces AJAX request to search
    const formData = new URLSearchParams();
    formData.append(FORM_ID, FORM_ID);
    formData.append("javax.faces.ViewState", this.viewState);
    formData.append(`${FORM_ID}:txtBusqueda`, "");
    // RichFaces uses specific AJAX parameters
    formData.append("javax.faces.source", `${FORM_ID}:j_idt15`);
    formData.append("javax.faces.partial.event", "click");
    formData.append("javax.faces.partial.execute", `${FORM_ID}:j_idt15 @component`);
    formData.append("javax.faces.partial.render", `${FORM_ID}:panel @component`);
    formData.append("javax.faces.behavior.event", "action");
    formData.append("javax.faces.partial.ajax", "true");

    // Alternatively, RichFaces may need org.richfaces.ajax parameters
    formData.append("org.richfaces.ajax.component", `${FORM_ID}:j_idt15`);
    formData.append("AJAX:EVENTS_COUNT", "1");

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

    return this.parsePaginatorInfo(xml);
  }

  // ---------------------------------------------------------------------------
  // Pagination & extraction
  // ---------------------------------------------------------------------------

  private async scrapePage(page: number): Promise<PjDocument[]> {
    if (page > 0) {
      await this.navigateToPage(page);
    }

    // For page 0, we parse from the search response
    // For other pages, we parse from the navigation response
    const response = await this.fetchPageContent(page);
    return this.parseResultsPage(response, page);
  }

  private async navigateToPage(page: number): Promise<void> {
    logger.debug(CTX, `Navigating to page ${page}...`);

    // RichFaces DataScroller pagination
    const formData = new URLSearchParams();
    formData.append(FORM_ID, FORM_ID);
    formData.append("javax.faces.ViewState", this.viewState);
    formData.append(`${FORM_ID}:txtBusqueda`, "");
    formData.append("javax.faces.partial.ajax", "true");
    formData.append("javax.faces.source", `${FORM_ID}:j_idt15`);
    formData.append(`${FORM_ID}:j_idt16`, String(page));

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
  }

  private async fetchPageContent(page: number): Promise<string> {
    // Fetch the current page by re-requesting with the current ViewState
    const formData = new URLSearchParams();
    formData.append(FORM_ID, FORM_ID);
    formData.append("javax.faces.ViewState", this.viewState);
    formData.append(`${FORM_ID}:txtBusqueda`, "");
    formData.append(`${FORM_ID}:j_idt16`, String(page));
    formData.append("javax.faces.partial.ajax", "true");
    formData.append("javax.faces.source", `${FORM_ID}:j_idt15`);
    formData.append("javax.faces.partial.render", `${FORM_ID}:panel`);
    formData.append("javax.faces.partial.execute", "@all");

    const response = await this.http.post(PAGE_PATH, formData.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Faces-Request": "partial/ajax",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${BASE_URL}${PAGE_PATH}`,
      },
    });

    this.updateViewStateFromAjax(response.data as string);
    return response.data as string;
  }

  private parseResultsPage(xml: string, pageNum: number): PjDocument[] {
    const documents: PjDocument[] = [];

    // Extract HTML from CDATA
    const html = this.extractCdataContent(xml, `${FORM_ID}:panel`);
    if (!html) {
      logger.warn(CTX, `No panel content found for page ${pageNum}`);
      return documents;
    }

    const $ = cheerio.load(html);

    // The PJ site renders results as a list of panels/divs, not a DataTable
    // Each result has: tipo, materia, tema, titulo, fecha, organo, PDF link
    $(".panel, .resultado-item, tr, .row").each((i, elem) => {
      const text = $(elem).text();

      // Try to extract structured data from result items
      const doc: PjDocument = {
        index: pageNum * 10 + i + 1,
        tipo: this.extractField($, elem, "tipo"),
        materia: this.extractField($, elem, "materia"),
        tema: this.extractField($, elem, "tema"),
        subtema: this.extractField($, elem, "subtema"),
        titulo: this.extractField($, elem, "titulo") || text.trim().substring(0, 200),
        fecha: this.extractField($, elem, "fecha"),
        organo: this.extractField($, elem, "organo") || this.extractField($, elem, "órgano"),
        pdfUrl: null,
        pdfDownloaded: false,
        pdfLocalPath: null,
        error: null,
      };

      // Look for PDF download links
      $(elem).find("a").each((_j, link) => {
        const href = $(link).attr("href") || "";
        const onclick = $(link).attr("onclick") || "";

        if (href.includes(".pdf") || href.includes("download") || href.includes("documento")) {
          doc.pdfUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
        }

        // RichFaces may use onclick to trigger PDF download
        if (onclick.includes("window.open") || onclick.includes("download")) {
          const match = onclick.match(/window\.open\(['"]([^'"]+)['"]/);
          if (match) {
            doc.pdfUrl = match[1].startsWith("http") ? match[1] : `${BASE_URL}${match[1]}`;
          }
        }
      });

      // Only add if we have some actual content
      if (doc.titulo || doc.tipo || doc.materia) {
        documents.push(doc);
      }
    });

    logger.debug(CTX, `Extracted ${documents.length} documents from page ${pageNum}`);
    return documents;
  }

  private extractField(
    $: ReturnType<typeof cheerio.load>,
    elem: Parameters<ReturnType<typeof cheerio.load>>[0],
    fieldName: string,
  ): string {
    // Try common patterns for labeled fields
    const labelSelectors = [
      `span:contains("${fieldName}")`,
      `label:contains("${fieldName}")`,
      `td:contains("${fieldName}")`,
      `strong:contains("${fieldName}")`,
      `b:contains("${fieldName}")`,
    ];

    for (const selector of labelSelectors) {
      const label = $(elem).find(selector).first();
      if (label.length > 0) {
        // Get the next sibling or parent's next content
        const next = label.next();
        if (next.length > 0) {
          return next.text().trim();
        }
        // Or the text after the label within the same parent
        const parentText = label.parent().text();
        const labelText = label.text();
        const afterLabel = parentText.substring(parentText.indexOf(labelText) + labelText.length);
        return afterLabel.replace(/^[\s:]+/, "").trim();
      }
    }

    return "";
  }

  // ---------------------------------------------------------------------------
  // PDF Downloads
  // ---------------------------------------------------------------------------

  private async downloadPagePdfs(documents: PjDocument[]): Promise<void> {
    const pdfDir = path.join(this.config.outputDir, "pdfs");
    ensureDir(pdfDir);

    for (const doc of documents) {
      if (!doc.pdfUrl) continue;

      try {
        const filename = sanitizeFilename(
          `${doc.index}_${doc.tipo}_${doc.materia}`.replace(/\//g, "-"),
        ) + ".pdf";

        logger.debug(CTX, `Downloading PDF: ${filename}`);

        const response = await this.http.download(doc.pdfUrl);

        if (response.status === 200) {
          const savedPath = saveFile(pdfDir, filename, Buffer.from(response.data));
          doc.pdfDownloaded = true;
          doc.pdfLocalPath = savedPath;
          logger.info(CTX, `Downloaded: ${filename}`);
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        doc.error = msg;
        doc.pdfDownloaded = false;

        appendLine(
          path.join(this.config.outputDir, "failed-downloads.txt"),
          `${new Date().toISOString()} | ${doc.index} | ${doc.pdfUrl} | ${msg}`,
        );

        logger.error(CTX, `Failed to download PDF for doc ${doc.index}: ${msg}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // JSF/RichFaces helpers
  // ---------------------------------------------------------------------------

  private extractViewState(html: string): string {
    const $ = cheerio.load(html);
    const input = $('input[name="javax.faces.ViewState"]');
    if (input.length > 0) {
      return input.val() as string || "";
    }
    const match = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/);
    return match ? match[1] : "";
  }

  private updateViewStateFromAjax(xml: string): void {
    // RichFaces format
    const match = xml.match(
      /<update\s+id="javax\.faces\.ViewState(?::0)?"[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/update>/,
    );

    if (match) {
      this.viewState = match[1];
      return;
    }

    // Also try RichFaces-specific state format
    const alt = xml.match(/id="javax\.faces\.ViewState"[^>]*value="([^"]*)"/);
    if (alt) {
      this.viewState = alt[1];
    }
  }

  private extractCdataContent(xml: string, elementId: string): string | null {
    const escapedId = elementId.replace(/:/g, "\\:");
    const regex = new RegExp(
      `<update\\s+id="${escapedId}"[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/update>`,
    );
    const match = xml.match(regex);

    if (!match) {
      const regex2 = new RegExp(
        `<update\\s+id="${elementId}"[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/update>`,
      );
      const match2 = xml.match(regex2);
      return match2 ? match2[1] : null;
    }

    return match[1];
  }

  private parsePaginatorInfo(xml: string): { totalRecords: number; totalPages: number } {
    // Try various patterns the PJ site might use
    const patterns = [
      /(\d+)\s+resultado/i,
      /Total:\s*(\d+)/i,
      /(\d+)\s+registros/i,
      /Mostrando\s+\d+\s+a\s+\d+\s+de\s+(\d+)/i,
    ];

    for (const pattern of patterns) {
      const match = xml.match(pattern);
      if (match) {
        const total = parseInt(match[1], 10);
        return { totalRecords: total, totalPages: Math.ceil(total / 10) };
      }
    }

    // If we can't find a total, return a conservative estimate
    // and paginate until we get an empty page
    logger.warn(CTX, "Could not determine total records. Will paginate until empty.");
    return { totalRecords: -1, totalPages: 999 };
  }

  // ---------------------------------------------------------------------------
  // Progress tracking
  // ---------------------------------------------------------------------------

  private saveProgress(page: number, totalPages: number, totalRecords: number): void {
    const progress: ScrapeProgress = {
      site: "pj",
      totalPages,
      lastCompletedPage: page,
      totalDocuments: totalRecords,
      documentsScraped: this.documents.length,
      documentsDownloaded: this.documents.filter((d) => d.pdfDownloaded).length,
      failedDownloads: this.documents.filter((d) => d.error).map((d) => String(d.index)),
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    };

    saveJson(this.config.outputDir, "progress-pj.json", progress);
  }
}
