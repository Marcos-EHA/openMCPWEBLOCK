/**
 * DOM Automation and extraction helpers for web AI platforms
 */

export interface DOMWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export class DOMAutomation {
  /**
   * Helper to sleep for a specified duration
   */
  static async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clean and normalize raw extracted HTML / Markdown text
   */
  static cleanExtractedText(raw: string): string {
    return raw
      .replace(/\r\n/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  /**
   * Detect if a stream response indicator is present
   */
  static isStreaming(indicators: string[]): boolean {
    return indicators.length > 0;
  }
}
