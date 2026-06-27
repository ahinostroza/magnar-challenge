/**
 * HTTP client with:
 * - Cookie jar (session persistence for JSF ViewState)
 * - Exponential backoff retry on 429 / network errors
 * - Configurable delays between requests
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HttpClientConfig {
  /** Base URL for all requests */
  baseUrl: string;
  /** Delay in ms between consecutive requests (default: 1000) */
  requestDelay?: number;
  /** Max retries on 429 or transient errors (default: 5) */
  maxRetries?: number;
  /** Initial backoff in ms for retry (default: 2000) */
  initialBackoff?: number;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
}

interface CookieEntry {
  name: string;
  value: string;
  path?: string;
  domain?: string;
}

// ---------------------------------------------------------------------------
// Sleep helper
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// HttpClient class
// ---------------------------------------------------------------------------

export class HttpClient {
  private client: AxiosInstance;
  private cookies: Map<string, CookieEntry> = new Map();
  private lastRequestTime = 0;
  private requestDelay: number;
  private maxRetries: number;
  private initialBackoff: number;

  constructor(private config: HttpClientConfig) {
    this.requestDelay = config.requestDelay ?? 1000;
    this.maxRetries = config.maxRetries ?? 5;
    this.initialBackoff = config.initialBackoff ?? 2000;

    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeout ?? 30000,
      maxRedirects: 5,
      validateStatus: () => true, // We handle status codes ourselves
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-PE,es;q=0.9,en;q=0.8",
      },
    });
  }

  // -------------------------------------------------------------------------
  // Cookie management
  // -------------------------------------------------------------------------

  private parseCookies(setCookieHeaders: string | string[] | undefined): void {
    if (!setCookieHeaders) return;
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];

    for (const header of headers) {
      const parts = header.split(";")[0]; // Only take name=value
      const eqIdx = parts.indexOf("=");
      if (eqIdx === -1) continue;
      const name = parts.substring(0, eqIdx).trim();
      const value = parts.substring(eqIdx + 1).trim();
      this.cookies.set(name, { name, value });
    }
  }

  private getCookieHeader(): string {
    return Array.from(this.cookies.values())
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  public getSessionId(): string | undefined {
    const jsession = this.cookies.get("JSESSIONID");
    return jsession?.value;
  }

  // -------------------------------------------------------------------------
  // Rate limiting (self-imposed)
  // -------------------------------------------------------------------------

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.requestDelay) {
      await sleep(this.requestDelay - elapsed);
    }
    this.lastRequestTime = Date.now();
  }

  // -------------------------------------------------------------------------
  // Request with retry
  // -------------------------------------------------------------------------

  async get(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse> {
    return this.requestWithRetry("GET", url, undefined, config);
  }

  async post(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse> {
    return this.requestWithRetry("POST", url, data, config);
  }

  async download(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<Buffer>> {
    return this.requestWithRetry("GET", url, undefined, {
      ...config,
      responseType: "arraybuffer",
    }) as Promise<AxiosResponse<Buffer>>;
  }

  private async requestWithRetry(
    method: string,
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.throttle();

      try {
        const reqConfig: AxiosRequestConfig = {
          ...config,
          method,
          url,
          data,
          headers: {
            ...config?.headers,
            Cookie: this.getCookieHeader(),
          },
        };

        const response = await this.client.request(reqConfig);

        // Store cookies from response
        this.parseCookies(response.headers["set-cookie"]);

        // Handle 429 - Too Many Requests
        if (response.status === 429) {
          const retryAfter = response.headers["retry-after"];
          const backoff = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : this.initialBackoff * Math.pow(2, attempt);

          // Add jitter (±20%)
          const jitter = backoff * (0.8 + Math.random() * 0.4);

          logger.warn(
            "HttpClient",
            `429 Too Many Requests on ${url} — retry ${attempt + 1}/${this.maxRetries} in ${Math.round(jitter)}ms`,
          );

          await sleep(jitter);
          continue;
        }

        // Handle server errors (5xx) with retry
        if (response.status >= 500) {
          const backoff = this.initialBackoff * Math.pow(2, attempt);
          const jitter = backoff * (0.8 + Math.random() * 0.4);

          logger.warn(
            "HttpClient",
            `Server error ${response.status} on ${url} — retry ${attempt + 1}/${this.maxRetries} in ${Math.round(jitter)}ms`,
          );

          await sleep(jitter);
          continue;
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Network errors — retry with backoff
        if (attempt < this.maxRetries) {
          const backoff = this.initialBackoff * Math.pow(2, attempt);
          const jitter = backoff * (0.8 + Math.random() * 0.4);

          logger.warn(
            "HttpClient",
            `Network error on ${url}: ${lastError.message} — retry ${attempt + 1}/${this.maxRetries} in ${Math.round(jitter)}ms`,
          );

          await sleep(jitter);
          continue;
        }
      }
    }

    throw new Error(`Request to ${url} failed after ${this.maxRetries} retries: ${lastError?.message}`);
  }
}
