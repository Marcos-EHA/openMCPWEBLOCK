/**
 * ConfidenceCalculator
 * Calculates consensus confidence based on convergence across agent key points and similarity
 */

import type { KeyPoint } from '../types/index.js';

export class ConfidenceCalculator {
  /**
   * Calculate confidence score (0.0 to 1.0) based on KeyPoints convergence
   */
  calculateConfidence(keyPoints: KeyPoint[], agentCount: number): number {
    if (agentCount <= 1 || keyPoints.length === 0) return 0.5;

    let rawScore = 0;
    for (const kp of keyPoints) {
      const ratio = kp.agreementRatio;
      if (ratio >= 0.99) {
        rawScore += 0.5;
      } else if (ratio >= 0.6) {
        rawScore += 0.25;
      } else {
        rawScore += 0.05;
      }
    }

    // Normalize score to [0.3, 1.0] range
    const maxPossible = Math.max(1, keyPoints.length * 0.5);
    const normalized = 0.3 + (rawScore / maxPossible) * 0.7;

    return Math.min(1.0, Math.max(0.3, Number(normalized.toFixed(2))));
  }
}
