/**
 * Scraper Challenge — CLI Entry Point
 *
 * Usage:
 *   npm start                          # Default: OEFA site, metadata + PDFs
 *   npm run start:oefa                 # Scrape OEFA
 *   npm run start:pj                   # Scrape PJ (requires VPN to Peru)
 *   npm run start:dry                  # Dry run: metadata only, no PDF downloads
 *
 *   ts-node src/index.ts --site oefa --max 50 --delay 1500 --no-download
 */

import * as path from "path";
import { OefaScraper } from "./scrapers/oefa-scraper";
import { PjScraper } from "./scrapers/pj-scraper";
import { ScraperConfig } from "./types";
import { logger, setLogLevel, LogLevel } from "./utils/logger";

const CTX = "Main";

// ---------------------------------------------------------------------------
// CLI argument parsing (minimal, no external deps)
// ---------------------------------------------------------------------------

function parseArgs(): ScraperConfig {
  const args = process.argv.slice(2);

  let site: "oefa" | "pj" = "oefa";
  let downloadPdfs = true;
  let maxDocuments = 0;
  let requestDelay = 1500;
  let maxRetries = 5;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--site":
        site = args[++i] as "oefa" | "pj";
        if (!["oefa", "pj"].includes(site)) {
          console.error(`Invalid site: ${site}. Use "oefa" or "pj".`);
          process.exit(1);
        }
        break;
      case "--max":
        maxDocuments = parseInt(args[++i], 10);
        break;
      case "--delay":
        requestDelay = parseInt(args[++i], 10);
        break;
      case "--retries":
        maxRetries = parseInt(args[++i], 10);
        break;
      case "--no-download":
      case "--dry-run":
        downloadPdfs = false;
        break;
      case "--verbose":
      case "-v":
        verbose = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown argument: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  if (verbose) {
    setLogLevel(LogLevel.DEBUG);
  }

  const outputDir = path.resolve(process.cwd(), "downloads", site);

  return {
    site,
    outputDir,
    downloadPdfs,
    maxDocuments,
    requestDelay,
    maxRetries,
  };
}

function printHelp(): void {
  console.log(`
Scraper Challenge — Legal Document Scraper

Usage:
  ts-node src/index.ts [options]

Options:
  --site <oefa|pj>   Site to scrape (default: oefa)
                      oefa = OEFA Tribunal (no VPN needed)
                      pj   = Jurisprudencia PJ (requires VPN to Peru)
  --max <number>      Max documents to scrape (default: 0 = all)
  --delay <ms>        Delay between requests in ms (default: 1500)
  --retries <number>  Max retries on 429/errors (default: 5)
  --no-download       Skip PDF downloads (metadata only)
  --dry-run           Same as --no-download
  --verbose, -v       Enable debug logging
  --help, -h          Show this help

Examples:
  ts-node src/index.ts --site oefa --max 20
  ts-node src/index.ts --site pj --delay 2000 --verbose
  ts-node src/index.ts --site oefa --dry-run
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = parseArgs();

  logger.info(CTX, "=".repeat(60));
  logger.info(CTX, "Scraper Challenge — Legal Document Scraper");
  logger.info(CTX, "=".repeat(60));
  logger.info(CTX, `Site:           ${config.site.toUpperCase()}`);
  logger.info(CTX, `Output:         ${config.outputDir}`);
  logger.info(CTX, `Download PDFs:  ${config.downloadPdfs}`);
  logger.info(CTX, `Max documents:  ${config.maxDocuments || "ALL"}`);
  logger.info(CTX, `Request delay:  ${config.requestDelay}ms`);
  logger.info(CTX, `Max retries:    ${config.maxRetries}`);
  logger.info(CTX, "=".repeat(60));

  const startTime = Date.now();

  try {
    if (config.site === "oefa") {
      const scraper = new OefaScraper(config);
      const documents = await scraper.scrape();
      printSummary(documents.length, startTime);
    } else {
      const scraper = new PjScraper(config);
      const documents = await scraper.scrape();
      printSummary(documents.length, startTime);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(CTX, `Fatal error: ${msg}`);

    if (error instanceof Error && error.stack) {
      logger.debug(CTX, error.stack);
    }

    process.exit(1);
  }
}

function printSummary(totalDocs: number, startTime: number): void {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(CTX, "=".repeat(60));
  logger.info(CTX, "SCRAPING COMPLETE");
  logger.info(CTX, `Documents scraped: ${totalDocs}`);
  logger.info(CTX, `Time elapsed:      ${elapsed}s`);
  logger.info(CTX, "=".repeat(60));
}

// Run
main();
