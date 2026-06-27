/**
 * File system utilities for saving scraped data and PDFs.
 */

import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger";

const CTX = "FileUtils";

/**
 * Ensures a directory exists, creating it recursively if needed.
 */
export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    logger.debug(CTX, `Created directory: ${dirPath}`);
  }
}

/**
 * Sanitizes a string for use as a filename.
 * Removes special characters, trims, and truncates.
 */
export function sanitizeFilename(name: string, maxLength = 100): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, maxLength);
}

/**
 * Saves a buffer to a file. Returns the full path.
 */
export function saveFile(dirPath: string, filename: string, data: Buffer): string {
  ensureDir(dirPath);
  const fullPath = path.join(dirPath, filename);
  fs.writeFileSync(fullPath, data);
  logger.debug(CTX, `Saved file: ${fullPath} (${data.length} bytes)`);
  return fullPath;
}

/**
 * Saves JSON data to a file. Returns the full path.
 */
export function saveJson(dirPath: string, filename: string, data: unknown): string {
  ensureDir(dirPath);
  const fullPath = path.join(dirPath, filename);
  fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), "utf-8");
  logger.info(CTX, `Saved JSON: ${fullPath}`);
  return fullPath;
}

/**
 * Loads a JSON file if it exists. Returns null otherwise.
 */
export function loadJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    logger.warn(CTX, `Failed to parse JSON: ${filePath}`);
    return null;
  }
}

/**
 * Appends a line to a file (useful for failed-downloads log).
 */
export function appendLine(filePath: string, line: string): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, line + "\n", "utf-8");
}
