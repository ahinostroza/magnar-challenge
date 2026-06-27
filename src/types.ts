/**
 * Shared types for the scraper.
 */

/** A scraped document record */
export interface ScrapedDocument {
  /** Row number from the table */
  index: number;
  /** Unique identifier (expediente number) */
  expediente: string;
  /** Administrado / party name */
  administrado: string;
  /** Fiscalizable unit */
  unidadFiscalizable: string;
  /** Sector (MINERIA, ELECTRICIDAD, etc.) */
  sector: string;
  /** Resolution number */
  nroResolucion: string;
  /** Whether a PDF is available for this document */
  hasPdf: boolean;
  /** Whether the PDF was successfully downloaded */
  pdfDownloaded: boolean;
  /** Local filename where PDF was saved (relative to pdfs/) */
  pdfFilename: string | null;
  /** Any error that occurred during processing */
  error: string | null;
}

/** @internal PDF download metadata — never serialized to output JSON */
export interface PdfDownloadInfo {
  /** JSF command button ID (e.g. "form:dt:0:j_idt63") */
  buttonId: string;
  /** UUID passed as param_uuid to the JSF form POST */
  uuid: string;
}

/** A scraped document from the PJ site */
export interface PjDocument {
  index: number;
  /** Tipo de jurisprudencia */
  tipo: string;
  /** Materia */
  materia: string;
  /** Tema */
  tema: string;
  /** Subtema */
  subtema: string;
  /** Titulo / Resumen */
  titulo: string;
  /** Fecha */
  fecha: string;
  /** Organo jurisdiccional */
  organo: string;
  /** PDF URL */
  pdfUrl: string | null;
  pdfDownloaded: boolean;
  pdfLocalPath: string | null;
  error: string | null;
}

/** Progress state for resumable scraping */
export interface ScrapeProgress {
  site: string;
  totalPages: number;
  lastCompletedPage: number;
  totalDocuments: number;
  documentsScraped: number;
  documentsDownloaded: number;
  failedDownloads: string[];
  startedAt: string;
  lastUpdatedAt: string;
}

/** Scraper configuration */
export interface ScraperConfig {
  /** Which site to scrape */
  site: "oefa" | "pj";
  /** Output directory for PDFs */
  outputDir: string;
  /** Whether to actually download PDFs (false = metadata only) */
  downloadPdfs: boolean;
  /** Max documents to scrape (0 = all) */
  maxDocuments: number;
  /** Delay between requests in ms */
  requestDelay: number;
  /** Max concurrent downloads */
  maxRetries: number;
}
