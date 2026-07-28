import { HttpStatus, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { type Browser, chromium } from "playwright";

import { ApplicationException } from "../presentation/errors/application.exception.js";

/**
 * Renders a self-contained HTML document to a real PDF file using a headless
 * Chromium (Playwright, Apache-2.0 — see Checkpoint 3 report for the library
 * comparison and rationale). This is the ONLY place a PDF is produced: the
 * HTML itself is built server-side from the report-data snapshot
 * (`driver-collection-report-html.ts`), never from a User's browser DOM, so
 * the document is fully server-authoritative and reproducible.
 *
 * The browser process is expensive to start, so one instance is kept warm and
 * reused across requests; each render gets its own isolated page, closed
 * immediately after. A render failure never touches application data — this
 * service only turns HTML into bytes and returns or throws.
 */
@Injectable()
export class DriverCollectionPdfService implements OnModuleDestroy {
  private browserPromise: Promise<Browser> | undefined;

  private async browser(): Promise<Browser> {
    this.browserPromise ??= chromium.launch({ headless: true }).catch((error: unknown) => {
      this.browserPromise = undefined;
      throw error;
    });
    return this.browserPromise;
  }

  public async renderPdf(html: string, footerTemplate: string): Promise<Buffer> {
    let browser: Browser;
    try {
      browser = await this.browser();
    } catch {
      throw new ApplicationException(
        "report_pdf_engine_unavailable",
        "The PDF engine could not start. The reconciliation data is unaffected.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: "load" });
      return await page.pdf({
        displayHeaderFooter: true,
        footerTemplate,
        format: "A4",
        headerTemplate: "<span></span>",
        margin: { bottom: "18mm", left: "12mm", right: "12mm", top: "14mm" },
        printBackground: true,
      });
    } catch (error) {
      throw new ApplicationException(
        "report_pdf_generation_failed",
        "The PDF could not be generated. The reconciliation data is unaffected.",
        HttpStatus.INTERNAL_SERVER_ERROR,
        error instanceof Error ? [error.message] : undefined,
      );
    } finally {
      await page.close();
    }
  }

  public async onModuleDestroy(): Promise<void> {
    if (this.browserPromise === undefined) return;
    const browser = await this.browserPromise.catch(() => undefined);
    await browser?.close();
  }
}
