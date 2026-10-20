/**
 * SimilarityAnalyzer
 * Analyzes similarity matrix between multiple agent responses
 */

import { TextComparison } from '../utils/TextComparison.js';
import type { SimilarityScore } from '../types/index.js';

export class SimilarityAnalyzer {
  /**
   * Compare two responses and return similarity score
   */
  compareResponses(r1: string, r2: string): SimilarityScore {
    return TextComparison.compare(r1, r2);
  }

  /**
   * Compute pairwise similarity matrix across an array of responses
   */
  computeSimilarityMatrix(responses: string[]): number[][] {
    const n = responses.length;
    const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(1.0));

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const score = this.compareResponses(responses[i], responses[j]).overall;
        matrix[i][j] = score;
        matrix[j][i] = score;
      }
    }

    return matrix;
  }
}
