/**
 * Research — retrieval-augmented answering over the document corpus.
 *
 * Two things on this page are unusual, and both are deliberate.
 *
 * First, **unverified claims are shown as unverified** rather than removed. Every
 * sentence of the answer is typed and checked against the passage that supports it,
 * and the failures stay in the answer with a marker. Removing them would produce a
 * cleaner paragraph whose remaining sentences carried an implied guarantee they had
 * not earned — the reader would have no way to tell a fully-grounded answer from a
 * partially-grounded one that had been tidied.
 *
 * Second, the corpus is **disclosed as synthetic** on the page itself, not in a
 * footnote. The documents are internally consistent and exercise the whole
 * retrieval and grounding pipeline, but a citation that looks like an SEC filing
 * and is not one would be materially misleading, and burying that in a comment
 * would be the wrong place for it.
 */

'use client';

import { useState } from 'react';
import { PageHeader, PageShell } from '@/components/PageState';
import {
  Badge,
  Button,
  Divider,
  INPUT_CLASS,
  Meter,
  Notice,
  Panel,
  PanelHeader,
  StatGrid,
  StatTile,
} from '@/components/ui/primitives';
import { ApiRequestError, request, useApi } from '@/lib/ui/api';
import { duration, fractionAsPercent, integer, nyDate, ratio, relativeTime } from '@/lib/ui/format';
import type { ClaimCategory, RagSourceType } from '@/lib/domain/types';

interface Citation {
  documentId: string;
  documentTitle: string;
  sourceType: RagSourceType;
  section: string;
  authority: number;
  score: number;
  snippet: string;
  publishedAt: number;
}

interface GroundedClaim {
  text: string;
  category: ClaimCategory;
  verified: boolean;
  citationIndex: number | null;
  evidence: string | null;
}

interface AnswerResponse {
  question: string;
  answer: string;
  citations: Citation[];
  claims: GroundedClaim[];
  source: 'deterministic_synthesis' | 'llm';
  llmProvider: string | null;
  elapsedMs: number;
  groundingScore: number;
  unverifiedClaims: number;
  trace: {
    queryTerms: string[];
    candidates: number;
    lexicalHits: number;
    denseHits: number;
    symbols: string[];
    bestBm25: number;
    bestDense: number;
    termsInCorpus: number;
    lexicalWeight: number;
    denseWeight: number;
    elapsedMs: number;
  };
  notes: string[];
  sourceLabels: Record<RagSourceType, string>;
  corpusNotice: string;
  ai: { provider: string; live: boolean; reason: string };
}

interface CorpusResponse {
  documents: number;
  chunks: number;
  symbols: number;
  bySource: { sourceType: RagSourceType; documents: number; authority: number }[];
  oldest: number;
  newest: number;
  sourceLabels: Record<RagSourceType, string>;
  sourceTypes: RagSourceType[];
  corpusNotice: string;
  examples: string[];
  ai: { provider: string; live: boolean; reason: string };
}

const CATEGORY_LABELS: Record<ClaimCategory, string> = {
  numerical: 'Numerical',
  temporal: 'Temporal',
  entity_attribute: 'Entity attribute',
  comparative: 'Comparative',
  regulatory: 'Regulatory',
  computational: 'Platform-derived',
};

/**
 * Renders the answer with its citation markers made legible.
 *
 * The markers arrive inline as `[1]`, `[2]`. They are split out and styled rather
 * than left as literal text so the eye can follow a sentence to its source — the
 * whole value of a cited answer is the ability to check it, and a marker that reads
 * as punctuation does not invite checking.
 */
function AnnotatedAnswer({ answer, onCitation }: { answer: string; onCitation: (index: number) => void }) {
  const parts = answer.split(/(\[\d+\])/g);
  return (
    <p className="text-sm leading-relaxed text-parchment">
      {parts.map((part, i) => {
        const match = /^\[(\d+)\]$/.exec(part);
        if (match === null) return <span key={i}>{part}</span>;
        const index = Number(match[1]);
        return (
          <button
            key={i}
            type="button"
            onClick={() => onCitation(index - 1)}
            className="mx-0.5 align-super font-mono text-2xs text-gold underline decoration-gold/40 hover:decoration-gold"
            aria-label={`Jump to citation ${index}`}
          >
            {index}
          </button>
        );
      })}
    </p>
  );
}

export default function ResearchPage() {
  const corpus = useApi<CorpusResponse>('/rag');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AnswerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [focusedCitation, setFocusedCitation] = useState<number | null>(null);

  async function ask(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length < 3 || pending) return;
    setPending(true);
    setError(null);
    setFocusedCitation(null);
    try {
      setAnswer(await request<AnswerResponse>('/rag', { method: 'POST', body: { question: trimmed } }));
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : 'The question could not be answered.');
      setAnswer(null);
    } finally {
      setPending(false);
    }
  }

  const notice = answer?.corpusNotice ?? corpus.data?.corpusNotice ?? null;
  const labels = answer?.sourceLabels ?? corpus.data?.sourceLabels ?? null;

  return (
    <PageShell wide>
      <PageHeader
        eyebrow="Grounded research"
        title="Research"
        lede="Ask a question about the document corpus. Retrieval fuses a lexical and a semantic channel, re-ranks on source authority, and then checks each sentence of the answer against the passage that supports it."
        action={
          corpus.data ? (
            <Badge tone={corpus.data.ai.live ? 'gold' : 'neutral'} title={corpus.data.ai.reason}>
              {corpus.data.ai.live ? `live · ${corpus.data.ai.provider}` : 'extractive synthesis'}
            </Badge>
          ) : null
        }
      />

      {notice !== null ? (
        <Notice tone="warning" title="The corpus is synthetic" className="mb-6">
          {notice}
        </Notice>
      ) : null}

      <Panel className="mb-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(question);
          }}
        >
          <label className="eyebrow mb-2 block" htmlFor="research-question">
            Your question
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              id="research-question"
              className={INPUT_CLASS}
              type="text"
              value={question}
              maxLength={600}
              placeholder="What did management say about gross margin guidance?"
              onChange={(e) => setQuestion(e.target.value)}
            />
            <Button type="submit" variant="primary" size="lg" busy={pending} disabled={question.trim().length < 3}>
              {pending ? 'Retrieving…' : 'Ask'}
            </Button>
          </div>
        </form>

        {corpus.data ? (
          <div className="mt-4">
            <p className="eyebrow mb-2">Try one of these</p>
            <div className="flex flex-wrap gap-2">
              {corpus.data.examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => {
                    setQuestion(example);
                    void ask(example);
                  }}
                  className="border border-obsidian-edge px-2.5 py-1 text-left text-[0.75rem] text-parchment-dim transition-colors hover:border-parchment-ghost hover:text-parchment"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </Panel>

      {error !== null ? (
        <Notice tone="error" title="Request failed" className="mb-5">
          {error}
        </Notice>
      ) : null}

      {answer !== null ? (
        <>
          <StatGrid className="mb-5" columns={5}>
            <StatTile
              label="Grounding"
              value={fractionAsPercent(answer.groundingScore)}
              tone={answer.groundingScore >= 0.999 ? 'sage' : answer.groundingScore >= 0.7 ? 'gold' : 'burgundy'}
              footnote={`${integer(answer.claims.length - answer.unverifiedClaims)} of ${integer(answer.claims.length)} claims verified`}
            />
            <StatTile label="Citations" value={integer(answer.citations.length)} footnote="After per-document diversification" />
            <StatTile
              label="Synthesis"
              value={answer.source === 'llm' ? (answer.llmProvider ?? 'model') : 'extractive'}
              size="sm"
              footnote={answer.source === 'llm' ? 'Generated, then graded' : 'Copied from sources; cannot fabricate'}
            />
            <StatTile
              label="Channel weights"
              value={`${Math.round(answer.trace.lexicalWeight * 100)}/${Math.round(answer.trace.denseWeight * 100)}`}
              size="sm"
              footnote="Lexical / semantic, set by each channel's dispersion on this query"
            />
            <StatTile label="Elapsed" value={duration(answer.elapsedMs)} size="sm" footnote="Retrieve, synthesise, ground" />
          </StatGrid>

          {answer.notes.length > 0 ? (
            <Notice tone="info" title="How this was retrieved" className="mb-5">
              <ul className="space-y-1">
                {answer.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </Notice>
          ) : null}

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
            <div className="space-y-5">
              <Panel>
                {/*
                  The only heading in the product whose text a user wrote.
                  `overflow-wrap` is inherited, so the class here reaches the
                  `<h2>` `PanelHeader` renders; every other panel title is
                  platform-authored and short, which is why the primitive does not
                  carry it. Without it a pasted filing URL — one 87-character token
                  with nothing to break at, and the field accepts 600 characters of
                  them — made the heading 652px wide inside a 308px column and
                  pushed the document to 693px against a 390px viewport, scrolling
                  the whole page sideways on a phone.
                */}
                <PanelHeader className="break-words" eyebrow="Answer" title={answer.question} />
                <div className="mt-4">
                  <AnnotatedAnswer answer={answer.answer} onCitation={setFocusedCitation} />
                </div>
              </Panel>

              <Panel>
                <PanelHeader
                  eyebrow="Claim verification"
                  title="Every sentence, checked"
                  detail="Each claim is typed, because verification means something different for a number than for a date or a statement about advisory scope."
                />
                {answer.claims.length === 0 ? (
                  <p className="mt-3 text-[0.8125rem] text-parchment-faint">
                    The answer asserts nothing, so there is nothing to verify.
                  </p>
                ) : (
                  <ul className="mt-4 space-y-3">
                    {answer.claims.map((claim, i) => (
                      <li key={i} className="border-t border-obsidian-edge pt-3 first:border-t-0 first:pt-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={claim.verified ? 'sage' : 'burgundy'}>
                            {claim.verified ? 'verified' : 'unverified'}
                          </Badge>
                          <Badge tone="ghost">{CATEGORY_LABELS[claim.category]}</Badge>
                          {claim.citationIndex !== null ? (
                            <button
                              type="button"
                              onClick={() => setFocusedCitation(claim.citationIndex)}
                              className="font-mono text-2xs text-gold underline decoration-gold/40 hover:decoration-gold"
                            >
                              source {claim.citationIndex + 1}
                            </button>
                          ) : null}
                        </div>
                        <p className="mt-2 text-[0.8125rem] leading-relaxed text-parchment-dim">{claim.text}</p>
                        {claim.evidence !== null ? (
                          <p className="mt-1.5 border-l-2 border-obsidian-edge pl-3 text-[0.75rem] leading-relaxed text-parchment-faint">
                            {claim.evidence}
                          </p>
                        ) : (
                          <p className="mt-1.5 text-[0.75rem] text-burgundy-bright">
                            No passage in the retrieved set supports this sentence. It is shown rather than removed so
                            you can judge it yourself.
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>

            <div className="space-y-5">
              <Panel>
                <PanelHeader
                  eyebrow="Citations"
                  title="Ranked sources"
                  detail="Authority is a fixed property of the source class; the score is the fused relevance after re-ranking."
                />
                <ol className="mt-4 space-y-4">
                  {answer.citations.map((citation, i) => (
                    <li
                      key={`${citation.documentId}-${i}`}
                      className={`border-l-2 pl-3 transition-colors ${
                        focusedCitation === i ? 'border-l-gold' : 'border-l-obsidian-edge'
                      }`}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-2xs text-gold">{i + 1}</span>
                        <p className="min-w-0 text-[0.8125rem] leading-snug text-parchment">{citation.documentTitle}</p>
                      </div>
                      <p className="mt-1 font-mono text-2xs uppercase tracking-institutional text-parchment-faint">
                        {labels?.[citation.sourceType] ?? citation.sourceType} · {citation.section}
                      </p>
                      <p className="mt-1 font-mono text-2xs text-parchment-ghost">
                        {nyDate(citation.publishedAt)} · {relativeTime(citation.publishedAt)}
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <span className="font-mono text-2xs text-parchment-faint">authority</span>
                        <Meter value={citation.authority} tone="gold" className="flex-1" />
                        <span className="tabular font-mono text-2xs text-parchment-faint">
                          {ratio(citation.authority, 2)}
                        </span>
                      </div>
                      <p className="mt-2 text-[0.75rem] leading-relaxed text-parchment-dim">{citation.snippet}</p>
                    </li>
                  ))}
                </ol>
              </Panel>

              <Panel>
                <PanelHeader eyebrow="Retrieval trace" title="What the retriever saw" />
                <dl className="mt-3 space-y-2 font-mono text-2xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-parchment-faint">candidates</dt>
                    <dd className="text-parchment-dim">{integer(answer.trace.candidates)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-parchment-faint">lexical hits</dt>
                    <dd className="text-parchment-dim">{integer(answer.trace.lexicalHits)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-parchment-faint">semantic hits</dt>
                    <dd className="text-parchment-dim">{integer(answer.trace.denseHits)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-parchment-faint">best BM25</dt>
                    <dd className="text-parchment-dim">{ratio(answer.trace.bestBm25, 2)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-parchment-faint">best cosine</dt>
                    <dd className="text-parchment-dim">{ratio(answer.trace.bestDense, 3)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-parchment-faint">query terms in corpus</dt>
                    <dd className="text-parchment-dim">
                      {integer(answer.trace.termsInCorpus)} / {integer(new Set(answer.trace.queryTerms).size)}
                    </dd>
                  </div>
                  {answer.trace.symbols.length > 0 ? (
                    <div className="flex justify-between gap-3">
                      <dt className="text-parchment-faint">scoped to</dt>
                      <dd className="text-parchment-dim">{answer.trace.symbols.join(', ')}</dd>
                    </div>
                  ) : null}
                </dl>
              </Panel>
            </div>
          </div>

          <Notice tone="legal" className="mt-5">
            A retrieved answer describes what documents say. It is not analysis of any security, not a recommendation,
            and not a statement that the underlying documents are accurate.
          </Notice>
        </>
      ) : (
        <Panel>
          <PanelHeader
            eyebrow="Corpus"
            title="What can be retrieved"
            detail="Ten source classes, ranked by evidentiary authority. A 10-K risk-factor disclosure and a forum post are not the same kind of claim, and the re-ranker treats them accordingly."
          />
          {corpus.data !== null ? (
            (() => {
              // Hoisted so the narrowing survives into the callbacks below;
              // `corpus.data` inside a `.map` is re-widened to nullable.
              const stats = corpus.data;
              return (
            <>
              <StatGrid className="mt-4" columns={4}>
                <StatTile label="Documents" value={integer(stats.documents)} />
                <StatTile label="Chunks" value={integer(stats.chunks)} footnote="Sentence-packed, one-sentence overlap" />
                <StatTile label="Symbols covered" value={integer(stats.symbols)} />
                <StatTile
                  label="Date span"
                  value={nyDate(stats.newest)}
                  size="sm"
                  footnote={`Oldest ${nyDate(stats.oldest)}`}
                />
              </StatGrid>
              <Divider className="my-4" />
              <div className="space-y-2.5">
                {stats.bySource.map((source) => (
                  <div key={source.sourceType} className="flex items-center gap-3">
                    <span className="w-44 shrink-0 text-[0.75rem] text-parchment-dim">
                      {stats.sourceLabels[source.sourceType]}
                    </span>
                    <Meter value={source.authority} tone="gold" className="flex-1" />
                    <span className="tabular w-20 shrink-0 text-right font-mono text-2xs text-parchment-faint sm:w-24">
                      {integer(source.documents)} docs · {ratio(source.authority, 2)}
                    </span>
                  </div>
                ))}
              </div>
            </>
              );
            })()
          ) : null}
        </Panel>
      )}
    </PageShell>
  );
}
