import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export interface MemoryMarkdownSearchHit {
  file: string;
  score: number;
  excerpt: string;
}

interface QueryTerm {
  value: string;
  weight: number;
}

interface MemoryDocument {
  file: string;
  content: string;
  normalized: string;
}

interface ScoredPassage {
  score: number;
  excerpt: string;
  matchedWeight: number;
}

const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_QUERY_TERMS = 80;
const PASSAGE_RADIUS = 650;
const MAX_OCCURRENCES_PER_TERM = 8;

const HAN_STOP_GRAMS = new Set([
  '一个',
  '一下',
  '一些',
  '之前',
  '以后',
  '以前',
  '他们',
  '你们',
  '我们',
  '不要',
  '应该',
  '自己',
  '什么',
  '事情',
  '问题',
  '为什么',
  '怎么',
  '怎样',
  '哪里',
  '哪个',
  '现在',
  '这个',
  '那个',
  '发现',
  '可以',
  '可能',
  '还是',
  '时候',
  '通过',
  '关于',
  '帮我',
  '看看',
]);

const HAN_STOP_CHARS = new Set(
  '的一了是在有和与及或也都就而又还着把被给让从到对为于呢吗吧呀哦谁哪怎这那',
);

const QUERY_ALIAS_GROUPS = [
  ['假说', 'thesis', 'hypothesis'],
  ['重启', '重新启动', 'restart', 'reboot'],
  ['飞书', 'lark'],
  ['多维表格', 'base', 'bitable'],
] as const;

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function addTerm(
  terms: Map<string, number>,
  value: string,
  weight: number,
  allowSingle = false,
): void {
  if ((!allowSingle && value.length < 2) || HAN_STOP_GRAMS.has(value)) return;
  terms.set(value, Math.max(terms.get(value) || 0, weight));
}

function segmentHanWords(token: string): string[] {
  try {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    return Array.from(segmenter.segment(token))
      .filter((part) => part.isWordLike)
      .map((part) => part.segment);
  } catch {
    return [];
  }
}

/**
 * Build overlapping Chinese n-grams plus ordinary latin/number tokens.
 * Longer n-grams carry more weight; document-frequency weighting later
 * suppresses common fragments without requiring a large language-specific
 * stop-word dictionary.
 */
export function buildMemorySearchTerms(query: string): QueryTerm[] {
  const normalized = normalizeText(query).trim();
  if (!normalized) return [];

  const terms = new Map<string, number>();
  const tokens = normalized.match(/[\p{L}\p{N}_-]+/gu) || [];
  for (const token of tokens) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      const words = segmentHanWords(token);
      for (const word of words) {
        if (word.length === 1 && !HAN_STOP_CHARS.has(word)) {
          addTerm(terms, word, 1.15, true);
        }
        addTerm(terms, word, word.length >= 3 ? 3.4 : 2.8);
        // Character n-grams stay within segmented word boundaries. Generating
        // them across the whole sentence creates meaningless terms such as
        // “要通” from “不要通过”, which used to dominate sparse queries.
        const maxN = Math.min(4, word.length);
        for (let size = 2; size <= maxN; size += 1) {
          const weight = size === 2 ? 0.55 : size === 3 ? 0.95 : 1.4;
          for (let index = 0; index <= word.length - size; index += 1) {
            addTerm(terms, word.slice(index, index + size), weight);
          }
        }
      }
      if (words.length === 0 && token.length >= 2 && token.length <= 12) {
        addTerm(terms, token, 3);
      }
    } else {
      addTerm(terms, token, token.length >= 6 ? 2.2 : 1.6);
    }
  }

  for (const aliases of QUERY_ALIAS_GROUPS) {
    if (!aliases.some((alias) => normalized.includes(alias))) continue;
    for (const alias of aliases) addTerm(terms, alias, 2.4);
  }

  return Array.from(terms, ([value, weight]) => ({ value, weight }))
    .sort(
      (left, right) =>
        right.weight - left.weight ||
        right.value.length - left.value.length ||
        left.value.localeCompare(right.value),
    )
    .slice(0, MAX_QUERY_TERMS);
}

function listMemoryDocuments(root: string): MemoryDocument[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < MAX_FILES) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      continue;
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.md') || entry.name.endsWith('.md.gz'))
      ) {
        files.push(fullPath);
        if (files.length >= MAX_FILES) break;
      }
    }
  }

  const documents: MemoryDocument[] = [];
  for (const file of files) {
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      const raw = fs.readFileSync(file);
      const content = file.endsWith('.gz')
        ? gunzipSync(raw).toString('utf-8')
        : raw.toString('utf-8');
      documents.push({
        file: path.relative(root, file).replaceAll(path.sep, '/'),
        content,
        normalized: normalizeText(content),
      });
    } catch {
      // A concurrently compacted/deleted file should not fail the whole query.
    }
  }
  return documents;
}

function countOccurrences(
  content: string,
  term: string,
  max = 12,
): number {
  let count = 0;
  let from = 0;
  while (count < max) {
    const found = content.indexOf(term, from);
    if (found < 0) break;
    count += 1;
    from = found + Math.max(1, term.length);
  }
  return count;
}

function sourceWeight(file: string): number {
  if (file === 'index.md' || file === 'personality.md') return 1.22;
  if (file.startsWith('knowledge/')) return 1.18;
  if (file.startsWith('impressions/')) return 1.05;
  if (file.startsWith('transcripts/')) return 0.9;
  if (file.startsWith('backups/')) return 0.55;
  return 1;
}

function lineBoundedExcerpt(
  content: string,
  center: number,
  radius = PASSAGE_RADIUS,
): string {
  let start = Math.max(0, center - radius);
  let end = Math.min(content.length, center + radius);
  const previousBreak = content.lastIndexOf('\n', start);
  const nextBreak = content.indexOf('\n', end);
  if (previousBreak >= 0) start = previousBreak + 1;
  if (nextBreak >= 0) end = nextBreak;
  return content.slice(start, end).trim().slice(0, 1_500);
}

function scoreBestPassage(
  document: MemoryDocument,
  terms: QueryTerm[],
  inverseDocumentFrequency: Map<string, number>,
  totalQueryWeight: number,
  normalizedQuery: string,
): ScoredPassage | null {
  const centers = new Set<number>();
  for (const term of terms) {
    let from = 0;
    for (
      let occurrence = 0;
      occurrence < MAX_OCCURRENCES_PER_TERM;
      occurrence += 1
    ) {
      const found = document.normalized.indexOf(term.value, from);
      if (found < 0) break;
      centers.add(found);
      from = found + Math.max(1, term.value.length);
    }
  }
  if (centers.size === 0) return null;

  let best: ScoredPassage | null = null;
  for (const center of centers) {
    const start = Math.max(0, center - PASSAGE_RADIUS);
    const end = Math.min(document.normalized.length, center + PASSAGE_RADIUS);
    const passage = document.normalized.slice(start, end);
    let lexicalScore = 0;
    let matchedWeight = 0;
    let matchedTerms = 0;

    for (const term of terms) {
      const tf = countOccurrences(passage, term.value, 6);
      if (tf === 0) continue;
      matchedTerms += 1;
      matchedWeight += term.weight;
      const idf = inverseDocumentFrequency.get(term.value) || 0;
      // Saturating TF prevents long transcripts and repeated boilerplate from
      // overwhelming a compact knowledge note.
      const saturatedTf = (tf * 2.2) / (tf + 1.2);
      lexicalScore += idf * term.weight * saturatedTf;
    }

    const coverage =
      totalQueryWeight > 0 ? matchedWeight / totalQueryWeight : 0;
    let score =
      lexicalScore +
      coverage * coverage * 18 +
      Math.min(8, matchedTerms * 0.35);
    if (
      normalizedQuery.length >= 3 &&
      normalizedQuery.length <= 120 &&
      passage.includes(normalizedQuery)
    ) {
      score += 22;
    }

    if (!best || score > best.score) {
      best = {
        score,
        matchedWeight,
        excerpt: lineBoundedExcerpt(document.content, center),
      };
    }
  }
  return best;
}

function contentFingerprint(document: MemoryDocument): string {
  // Exact duplicate transcripts can exist during migration/retry. A compact
  // prefix+suffix fingerprint keeps them from occupying several top slots.
  const normalized = document.normalized.replace(/\s+/g, ' ').trim();
  return `${normalized.length}:${normalized.slice(0, 600)}:${normalized.slice(-300)}`;
}

export function searchMemoryMarkdownRoot(
  root: string,
  query: string,
  limit = 8,
): MemoryMarkdownSearchHit[] {
  const terms = buildMemorySearchTerms(query);
  if (terms.length === 0) return [];
  const documents = listMemoryDocuments(root);
  if (documents.length === 0) return [];

  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    let frequency = 0;
    for (const document of documents) {
      if (document.normalized.includes(term.value)) frequency += 1;
    }
    documentFrequency.set(term.value, frequency);
  }

  const inverseDocumentFrequency = new Map<string, number>();
  for (const term of terms) {
    const frequency = documentFrequency.get(term.value) || 0;
    inverseDocumentFrequency.set(
      term.value,
      Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5)),
    );
  }

  const totalQueryWeight = terms.reduce(
    (total, term) => total + term.weight,
    0,
  );
  const normalizedQuery = normalizeText(query).trim();
  const hasPresentIntent =
    /(?:现在|当前|如今|最新|现行|默认|目前|还在|应该)/u.test(
      normalizedQuery,
    );
  const scored: Array<MemoryMarkdownSearchHit & { fingerprint: string }> = [];

  for (const document of documents) {
    const passage = scoreBestPassage(
      document,
      terms,
      inverseDocumentFrequency,
      totalQueryWeight,
      normalizedQuery,
    );
    if (!passage) continue;

    const normalizedPath = normalizeText(document.file);
    let pathBoost = 0;
    for (const term of terms) {
      if (normalizedPath.includes(term.value)) {
        pathBoost +=
          (inverseDocumentFrequency.get(term.value) || 0) * term.weight * 0.8;
      }
    }

    const normalizedExcerpt = normalizeText(passage.excerpt);
    const presentStateBoost = hasPresentIntent
      ? Math.min(
          18,
          [
            '现行',
            '当前',
            '目前',
            '默认',
            '已决定',
            '已明确',
            '取代',
            '退休',
            '不再',
          ].reduce(
            (boost, marker) =>
              boost + (normalizedExcerpt.includes(marker) ? 3 : 0),
            0,
          ),
        )
      : 0;

    scored.push({
      file: document.file,
      score: Number(
        (
          (passage.score + pathBoost + presentStateBoost) *
          sourceWeight(document.file)
        ).toFixed(3),
      ),
      excerpt: passage.excerpt,
      fingerprint: contentFingerprint(document),
    });
  }

  scored.sort(
    (left, right) =>
      right.score - left.score || left.file.localeCompare(right.file),
  );
  const maxResults = Math.max(1, Math.min(20, Math.floor(limit)));
  const seen = new Set<string>();
  const results: MemoryMarkdownSearchHit[] = [];
  for (const hit of scored) {
    if (seen.has(hit.fingerprint)) continue;
    seen.add(hit.fingerprint);
    results.push({ file: hit.file, score: hit.score, excerpt: hit.excerpt });
    if (results.length >= maxResults) break;
  }
  return results;
}
