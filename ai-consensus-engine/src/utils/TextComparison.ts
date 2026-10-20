/**
 * Text comparison utilities (lexical similarity, jaccard, edit distance)
 */

import type { SimilarityScore } from '../types/index.js';

export class TextComparison {
  /**
   * Tokenize text into words/tokens (lowercase, stripped punctuation)
   */
  static tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length > 0);
  }

  /**
   * Calculate Jaccard similarity between two texts (0.0 to 1.0)
   */
  static jaccardSimilarity(textA: string, textB: string): number {
    const tokensA = new Set(this.tokenize(textA));
    const tokensB = new Set(this.tokenize(textB));

    if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
    if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

    let intersectionCount = 0;
    for (const token of tokensA) {
      if (tokensB.has(token)) {
        intersectionCount++;
      }
    }

    const unionCount = tokensA.size + tokensB.size - intersectionCount;
    return unionCount > 0 ? intersectionCount / unionCount : 0.0;
  }

  /**
   * Compute normalized Levenshtein distance similarity (0.0 to 1.0)
   */
  static levenshteinSimilarity(s1: string, s2: string): number {
    const len1 = s1.length;
    const len2 = s2.length;
    if (len1 === 0 && len2 === 0) return 1.0;
    if (len1 === 0 || len2 === 0) return 0.0;

    // Use a single row DP array
    const maxLen = Math.max(len1, len2);
    let prevRow = new Array(len2 + 1);
    let currRow = new Array(len2 + 1);

    for (let j = 0; j <= len2; j++) {
      prevRow[j] = j;
    }

    for (let i = 1; i <= len1; i++) {
      currRow[0] = i;
      const char1 = s1[i - 1];
      for (let j = 1; j <= len2; j++) {
        const cost = char1 === s2[j - 1] ? 0 : 1;
        currRow[j] = Math.min(
          prevRow[j] + 1,      // deletion
          currRow[j - 1] + 1,  // insertion
          prevRow[j - 1] + cost // substitution
        );
      }
      [prevRow, currRow] = [currRow, prevRow];
    }

    const distance = prevRow[len2];
    return 1 - distance / maxLen;
  }

  /**
   * Full comparison returning SimilarityScore
   */
  static compare(textA: string, textB: string): SimilarityScore {
    const jaccard = this.jaccardSimilarity(textA, textB);
    const lev = this.levenshteinSimilarity(textA.slice(0, 1000), textB.slice(0, 1000));
    const overall = (jaccard * 0.7) + (lev * 0.3);

    return {
      overall,
      lexical: jaccard,
      details: {
        jaccard,
        levenshtein: lev,
      },
    };
  }
}
