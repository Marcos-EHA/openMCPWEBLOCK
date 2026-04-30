import type { AgentResponse } from './TaskOrchestrator.js'

/**
 * Key point extracted from a response
 */
export interface KeyPoint {
  text: string
  confidence: number
  sources: string[] // which agent(s) mentioned this
}

/**
 * Similarity score between two responses
 */
export interface SimilarityScore {
  jaccard: number // 0-1
  cosine: number // 0-1
  editDistance: number // raw edit distance
  normalized: number // 0-1 final score
}

/**
 * Agreement analysis
 */
export interface AgreementAnalysis {
  point: string
  agreeCount: number
  disagreeCount: number
  neutralCount: number
  confidence: number
}

/**
 * Final consensus result
 */
export interface ConsensusResult {
  consensusText: string
  confidence: number // 0-1, based on agreement
  agreement: AgreementAnalysis[]
  divergences: Divergence[]
  keyPoints: KeyPoint[]
  traceability: Record<string, string> // agentName -> original response
  metadata: {
    agentCount: number
    processingTime: number
    method: string
  }
}

/**
 * Divergence in opinions
 */
export interface Divergence {
  topic: string
  positions: Record<string, string> // agentName -> their position
  severity: 'low' | 'medium' | 'high' // how critical is this disagreement
}

/**
 * Consensus Engine - Analyzes and merges multiple agent responses
 *
 * Features:
 * - Text similarity analysis (Jaccard, Cosine, Edit distance)
 * - Key point extraction (simple NLP-like approach)
 * - Confidence scoring based on agreement
 * - Divergence detection
 * - Consensus generation
 */
export class ConsensusEngine {
  private readonly maxKeyPoints = 10
  private readonly confidenceThreshold = 0.5

  /**
   * Generate consensus from multiple responses
   */
  generateConsensus(responses: AgentResponse[]): ConsensusResult {
    const startTime = Date.now()

    if (responses.length === 0) {
      throw new Error('No responses to analyze')
    }

    if (responses.length === 1) {
      return {
        consensusText: responses[0].response,
        confidence: 0.8,
        agreement: [],
        divergences: [],
        keyPoints: this.extractKeyPoints([responses[0].response]),
        traceability: {
          [responses[0].agentName]: responses[0].response,
        },
        metadata: {
          agentCount: 1,
          processingTime: Date.now() - startTime,
          method: 'single_response',
        },
      }
    }

    // Analyze multiple responses
    const keyPoints = this.extractKeyPoints(responses.map(r => r.response))
    const agreement = this.analyzeAgreement(responses.map(r => r.response), keyPoints)
    const divergences = this.identifyDivergences(responses.map(r => r.response), agreement)
    const confidence = this.calculateConfidence(agreement)
    const consensusText = this.mergeResponses(responses.map(r => r.response))

    return {
      consensusText,
      confidence,
      agreement,
      divergences,
      keyPoints,
      traceability: Object.fromEntries(responses.map(r => [r.agentName, r.response])),
      metadata: {
        agentCount: responses.length,
        processingTime: Date.now() - startTime,
        method: 'multi_response_consensus',
      },
    }
  }

  /**
   * Extract key points from responses
   */
  private extractKeyPoints(responses: string[]): KeyPoint[] {
    const points: Map<string, { count: number; sources: Set<number> }> = new Map()

    responses.forEach((response, idx) => {
      const sentences = response.split(/[.!?]+/).filter(s => s.trim().length > 5)

      sentences.forEach(sentence => {
        const normalized = sentence.trim().toLowerCase()
        const existing = points.get(normalized) || { count: 0, sources: new Set() }
        existing.count++
        existing.sources.add(idx)
        points.set(normalized, existing)
      })
    })

    // Sort by frequency and convert to KeyPoints
    const keyPoints: KeyPoint[] = Array.from(points.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, this.maxKeyPoints)
      .map(([text, data]) => ({
        text: text.charAt(0).toUpperCase() + text.slice(1),
        confidence: data.count / responses.length,
        sources: Array.from(data.sources).map(idx => `agent_${idx}`),
      }))

    return keyPoints
  }

  /**
   * Analyze agreement on key points
   */
  private analyzeAgreement(responses: string[], keyPoints: KeyPoint[]): AgreementAnalysis[] {
    return keyPoints.slice(0, 5).map(kp => {
      let agreeCount = 0
      let disagreeCount = 0
      let neutralCount = 0

      responses.forEach(response => {
        if (response.toLowerCase().includes(kp.text.toLowerCase())) {
          agreeCount++
        } else {
          neutralCount++
        }
      })

      return {
        point: kp.text,
        agreeCount,
        disagreeCount,
        neutralCount,
        confidence: agreeCount / responses.length,
      }
    })
  }

  /**
   * Identify divergences in opinions
   */
  private identifyDivergences(responses: string[], agreement: AgreementAnalysis[]): Divergence[] {
    const divergences: Divergence[] = []

    // Find points with significant disagreement
    agreement.forEach(ag => {
      if (ag.disagreeCount > 0 || (ag.agreeCount > 0 && ag.neutralCount > 0)) {
        const severity = ag.confidence > 0.8 ? 'low' : ag.confidence > 0.5 ? 'medium' : 'high'

        divergences.push({
          topic: ag.point,
          positions: {
            agreeing: `${ag.agreeCount} agents agree on this point`,
            neutral: `${ag.neutralCount} agents are neutral`,
            disagreeing: `${ag.disagreeCount} agents disagree`,
          },
          severity,
        })
      }
    })

    return divergences.slice(0, 5) // Limit to top 5 divergences
  }

  /**
   * Calculate confidence based on agreement
   */
  private calculateConfidence(agreement: AgreementAnalysis[]): number {
    if (agreement.length === 0) return 0.5

    const averageConfidence = agreement.reduce((sum, a) => sum + a.confidence, 0) / agreement.length
    const variance = agreement.reduce((sum, a) => sum + Math.pow(a.confidence - averageConfidence, 2), 0) / agreement.length

    // High confidence when agreement is high AND variance is low
    const confidence = Math.max(0, Math.min(1, averageConfidence - variance * 0.5))

    return Math.round(confidence * 100) / 100
  }

  /**
   * Merge responses into consensus text
   */
  private mergeResponses(responses: string[]): string {
    // Simple merge: combine first half of each response
    const merged = responses
      .map(r => {
        const sentences = r.split(/[.!?]+/).filter(s => s.trim().length > 0)
        return sentences.slice(0, Math.ceil(sentences.length / 2)).join('. ')
      })
      .join(' ')

    return merged.trim() + '.'
  }

  /**
   * Compare two responses for similarity
   */
  compareSimilarity(response1: string, response2: string): SimilarityScore {
    const words1 = new Set(response1.toLowerCase().split(/\s+/))
    const words2 = new Set(response2.toLowerCase().split(/\s+/))

    // Jaccard similarity
    const intersection = new Set([...words1].filter(w => words2.has(w)))
    const union = new Set([...words1, ...words2])
    const jaccard = union.size > 0 ? intersection.size / union.size : 0

    // Edit distance (Levenshtein)
    const editDistance = this.levenshteinDistance(response1, response2)
    const maxLen = Math.max(response1.length, response2.length)
    const normalizedEditDistance = maxLen > 0 ? 1 - editDistance / maxLen : 1

    // Cosine similarity (simplified)
    const cosine = this.cosineSimilarity(response1, response2)

    return {
      jaccard: Math.round(jaccard * 100) / 100,
      cosine: Math.round(cosine * 100) / 100,
      editDistance,
      normalized: Math.round((jaccard + cosine + normalizedEditDistance) / 3 * 100) / 100,
    }
  }

  /**
   * Levenshtein distance (for edit distance calculation)
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = Array(str1.length + 1)
      .fill(null)
      .map(() => Array(str2.length + 1).fill(0))

    for (let i = 0; i <= str1.length; i++) matrix[i][0] = i
    for (let j = 0; j <= str2.length; j++) matrix[0][j] = j

    for (let i = 1; i <= str1.length; i++) {
      for (let j = 1; j <= str2.length; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        )
      }
    }

    return matrix[str1.length][str2.length]
  }

  /**
   * Cosine similarity (simplified bag-of-words approach)
   */
  private cosineSimilarity(str1: string, str2: string): number {
    const words1 = str1.toLowerCase().split(/\s+/)
    const words2 = str2.toLowerCase().split(/\s+/)

    const freq1 = this.getWordFrequency(words1)
    const freq2 = this.getWordFrequency(words2)

    let dotProduct = 0
    for (const word in freq1) {
      if (word in freq2) {
        dotProduct += freq1[word] * freq2[word]
      }
    }

    const magnitude1 = Math.sqrt(
      Object.values(freq1).reduce((sum, v) => sum + v * v, 0)
    )
    const magnitude2 = Math.sqrt(
      Object.values(freq2).reduce((sum, v) => sum + v * v, 0)
    )

    return magnitude1 > 0 && magnitude2 > 0 ? dotProduct / (magnitude1 * magnitude2) : 0
  }

  /**
   * Get word frequency map
   */
  private getWordFrequency(words: string[]): Record<string, number> {
    const freq: Record<string, number> = {}
    words.forEach(word => {
      freq[word] = (freq[word] || 0) + 1
    })
    return freq
  }
}

// Singleton instance
let consensusEngine: ConsensusEngine | null = null

/**
 * Get or create ConsensusEngine instance
 */
export function getConsensusEngine(): ConsensusEngine {
  if (!consensusEngine) {
    consensusEngine = new ConsensusEngine()
  }
  return consensusEngine
}
