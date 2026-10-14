"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Zap, Shield, Cpu, Globe, ArrowRight, BarChart2, Layers, Target, Brain, CheckCircle2, Sparkles, Lock } from "lucide-react";
import { toast } from "react-hot-toast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SustainabilityMetrics } from "@/types/multi-llm";
import { useAuth } from "@/components/auth/AuthProvider";
import { consumeEnsembleStream } from "@/lib/consumeSseStream";
import { estimateQueryCost, formatCostEstimate } from "@/lib/costEstimator";
import { parseAvailableProviderFamilies } from "@/lib/promptRouting";
import type { ProviderFamily } from "@/lib/providerPricing";

const quickPrompts = [
  "Explain quantum computing in simple terms",
  "What are the risks of relying on a single AI model?",
  "How can I reduce my carbon footprint?",
];

// The local-only trained model is a tiny 6-layer transformer trained only on
// Q&A about MultiLLM's own internals (see train/data/corpus.json) -- it has
// no general-knowledge training data, so the prompts above produce incoherent
// output when local-only mode is on. These are real corpus questions (each
// appears ~20x with consistent, on-topic answers) so local-only mode's quick
// prompts actually showcase what this model can do well.
const LOCAL_ONLY_QUICK_PROMPTS = [
  "How does the ensemble handle conflicting answers from different models?",
  "What happens to private information in prompts and replies?",
  "What are the limits of the tiny local models?",
];

// Feature 2: human-readable labels for the pipeline stages streamed back
// before synthesis tokens start arriving -- the parallel bot/scoring phases
// aren't themselves token-streamed, so this is what fills that wait.
const STAGE_LABELS: Record<string, string> = {
  querying_models: "Querying models...",
  scoring_candidates: "Scoring candidates...",
  synthesizing: "Synthesizing...",
  deep_review: "Cross-checking confidence...",
};

const LOCAL_ONLY_STORAGE_KEY = "multillm_local_only_mode";

export default function HomePage() {
  const { user, updateProfile } = useAuth();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<
    | null
    | {
        answer: string;
        metrics: SustainabilityMetrics;
        deep_review_confidence?: number | null;
        refined_prompt?: string | null;
        token_savings?: { tokens_saved_pct?: number } | null;
      }
  >(null);
  const [isLoading, setIsLoading] = useState(false);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [deepReview, setDeepReview] = useState(false);
  // Feature 2 (streaming synthesis): status text for the parallel-bot/scoring
  // stages (which aren't themselves streamed -- there's nothing to show
  // token-by-token until synthesis starts) plus the synthesis answer's text
  // as it arrives, so the user isn't staring at a blank screen the whole
  // pipeline.
  const [streamStage, setStreamStage] = useState<string | null>(null);
  const [streamingAnswer, setStreamingAnswer] = useState("");
  // Feature 4 (local-only mode): forces the whole pipeline onto the local
  // TinyGPT models, zero remote calls. Initialized from the user's saved
  // preference (or localStorage for an anonymous visitor) below.
  const [localOnly, setLocalOnly] = useState(false);
  // Feature 3 (cost estimator): which provider families are actually
  // available to this caller, fetched once so the estimate can narrow to
  // real options instead of assuming every provider is configured.
  const [availableProviders, setAvailableProviders] = useState<ProviderFamily[] | null>(null);

  const plan = user?.profile?.plan || "free";
  const deepReviewAvailable = plan === "pro" || plan === "enterprise";

  const queryClient = useQueryClient();

  const costEstimate = useMemo(
    () => estimateQueryCost(query, availableProviders, localOnly),
    [query, availableProviders, localOnly]
  );
  const costLabel = formatCostEstimate(costEstimate);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/query");
        const json = await res.json();
        setAvailableProviders(parseAvailableProviderFamilies(json.models || []));
      } catch {
        setAvailableProviders(null);
      }
    })();
  }, []);

  useEffect(() => {
    if (!user?.id) {
      setProjects([]);
      return;
    }
    (async () => {
      try {
        const res = await fetch("/api/client-projects");
        const json = await res.json();
        setProjects(json.projects || []);
      } catch {
        setProjects([]);
      }
    })();
  }, [user?.id]);

  // Feature 4: local-only mode is a per-user preference -- persisted on the
  // profile row for a logged-in user (works in both demo and real Supabase
  // mode, since useAuth().updateProfile already handles both), or
  // localStorage for an anonymous visitor who has no profile row at all.
  useEffect(() => {
    if (user) {
      setLocalOnly(Boolean(user.profile?.local_only_mode));
      return;
    }
    if (typeof window !== "undefined") {
      setLocalOnly(window.localStorage.getItem(LOCAL_ONLY_STORAGE_KEY) === "1");
    }
  }, [user]);

  const handleLocalOnlyToggle = async (checked: boolean) => {
    setLocalOnly(checked);
    if (user) {
      try {
        await updateProfile({ local_only_mode: checked });
      } catch {
        toast.error("Couldn't save local-only mode preference");
      }
    } else if (typeof window !== "undefined") {
      window.localStorage.setItem(LOCAL_ONLY_STORAGE_KEY, checked ? "1" : "0");
    }
  };

  const runQuery = async (text: string) => {
    if (!text.trim()) return;
    setQuery(text);
    setIsLoading(true);
    setResult(null);
    setStreamingAnswer("");
    setStreamStage("querying_models");
    const toastId = toast.loading(STAGE_LABELS.querying_models);

    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: text,
          project_id: selectedProjectId || undefined,
          deep_review: deepReviewAvailable && deepReview,
          local_only: localOnly,
          stream: true,
        }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || `Ensemble query failed (${res.status})`);
      }

      const finalPayload = await consumeEnsembleStream(res.body, {
        onStage: (stage) => {
          setStreamStage(stage);
          toast.loading(STAGE_LABELS[stage] || "Running ensemble...", { id: toastId });
        },
        onToken: (chunk) => setStreamingAnswer((prev) => prev + chunk),
        onRedacted: (text) => setStreamingAnswer(text),
      });
      if (!finalPayload) {
        throw new Error("Ensemble stream ended without a result");
      }

      toast.success("Ensemble complete!", { id: toastId });
      setResult({
        answer: finalPayload.answer,
        metrics: {
          accuracy: finalPayload.metrics?.top_score || 0,
          latency_s: (finalPayload.metrics?.latency_ms || 0) / 1000,
          carbon_saved_g: finalPayload.metrics?.carbon_saved_g || 0,
          emissions_g: finalPayload.metrics?.emissions_g || 0,
        },
        deep_review_confidence: finalPayload.confidence_score,
        refined_prompt: finalPayload.refined_prompt,
        token_savings: finalPayload.token_savings,
      });

      queryClient.invalidateQueries({ queryKey: ['user-stats'] });

    } catch (error) {
      toast.error(`Query failed: ${(error as Error).message}`, { id: toastId });
      setResult(null);
    } finally {
      setIsLoading(false);
      setStreamStage(null);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    runQuery(query);
  };

  return (
    <div className="space-y-12">
      {/* Hero Section - Multi-LLM Focus */}
      <section className="relative text-center py-16 overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-24 h-80 bg-[radial-gradient(ellipse_at_top,_theme(colors.purple.200),_transparent_65%)]"
        />
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="relative"
        >
          <h1 className="text-5xl md:text-6xl font-bold tracking-tight text-slate-900 mb-4">
            Multi<span className="bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">LLM</span>
          </h1>
          <p className="text-xl text-slate-600 max-w-3xl mx-auto mb-8">
            One prompt. <span className="font-semibold text-purple-600">Multiple LLMs.</span>
            The best answer, automatically selected.
          </p>

          <div className="flex flex-wrap justify-center gap-4 mb-8">
            {[
              { icon: Brain, label: "Ensemble Scoring", color: "text-purple-600" },
              { icon: Target, label: "Best Answer Selection", color: "text-blue-600" },
              { icon: Layers, label: "Multi-Provider", color: "text-emerald-600" },
              { icon: Shield, label: "Privacy First", color: "text-orange-600" }
            ].map((feature, index) => {
              const Icon = feature.icon;
              return (
                <div
                  key={index}
                  className="flex items-center gap-2 bg-white rounded-full px-4 py-2 shadow-sm ring-1 ring-slate-100"
                >
                  <Icon className={`w-5 h-5 ${feature.color}`} />
                  <span className="text-sm font-medium text-slate-700">{feature.label}</span>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 mb-12 text-sm text-slate-400">
            <span className="uppercase tracking-wide text-xs text-slate-400">Ensembles across</span>
            {["OpenAI", "Gemini", "Mistral", "Groq"].map((provider) => (
              <span key={provider} className="font-medium text-slate-500">{provider}</span>
            ))}
          </div>
        </motion.div>

        {/* Query Input */}
        <motion.div
          id="try-it"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="relative max-w-2xl mx-auto scroll-mt-24"
        >
          <form onSubmit={handleSubmit} className="flex gap-3">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                localOnly
                  ? "Ask about MultiLLM itself... (e.g., 'How are provider keys managed?')"
                  : "Ask anything... (e.g., 'Explain quantum computing')"
              }
              className="flex-1 px-6 py-4 rounded-xl border border-slate-300 focus:border-purple-500 focus:ring-2 focus:ring-purple-200 transition-all text-lg"
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={isLoading || !query.trim()}
              className="px-8 py-4 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-300 text-white rounded-xl font-semibold transition-colors flex items-center gap-2"
            >
              {isLoading ? "Running ensemble..." : "Ask MultiLLM"}
              <Zap className="w-5 h-5" />
            </button>
          </form>

          {/* Feature 3: pre-send cost estimate, updates live as the user types */}
          {query.trim() && costLabel && (
            <p className="mt-2 text-center text-xs text-slate-400">{costLabel}</p>
          )}

          {/* Feature 4: local-only mode -- available to anyone, not just
              logged-in users (an anonymous visitor's choice is kept in
              localStorage; see handleLocalOnlyToggle). */}
          <div className="mt-3 flex items-center justify-center gap-2">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={localOnly}
                onChange={(e) => handleLocalOnlyToggle(e.target.checked)}
                disabled={isLoading}
              />
              Local-only mode
            </label>
            {localOnly && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                <Lock className="w-3 h-3" />
                Local mode: no data leaves this device
              </span>
            )}
          </div>

          {/* The trained generator is a tiny 6-layer transformer trained
              from scratch on ~2,300 examples (see train/data/corpus.json) --
              it genuinely runs with zero API cost and zero data leaving the
              device, but its answers are noticeably rougher than the paid
              ensemble's. Set expectations rather than let it read as broken. */}
          {localOnly && (
            <p className="mt-2 text-center text-xs text-slate-400">
              Experimental: a tiny from-scratch model answers locally, so phrasing may be rough. Shown to demonstrate zero-cost, fully private queries.
            </p>
          )}

          {projects.length > 0 && (
            <div className="mt-3 flex items-center justify-center gap-2">
              <label htmlFor="project-select" className="text-sm text-slate-500">
                Tag this query to:
              </label>
              <select
                id="project-select"
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                className="text-sm px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700"
                disabled={isLoading}
              >
                <option value="">No client project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {user && (
            <div className="mt-3 flex items-center justify-center gap-2">
              <label
                className={`flex items-center gap-2 text-sm ${deepReviewAvailable ? "text-slate-600" : "text-slate-400"}`}
              >
                <input
                  type="checkbox"
                  checked={deepReviewAvailable && deepReview}
                  onChange={(e) => setDeepReview(e.target.checked)}
                  disabled={!deepReviewAvailable || isLoading}
                />
                Deep Review (cross-check with an extra model call for a confidence score)
              </label>
              {!deepReviewAvailable && (
                <a href="/dashboard/billing" className="text-xs text-purple-600 underline">
                  Upgrade to enable
                </a>
              )}
            </div>
          )}

          {/* Quick prompts -- swapped to in-domain questions under local-only
              mode, since the tiny local model only knows how to answer
              questions about MultiLLM itself (see LOCAL_ONLY_QUICK_PROMPTS). */}
          <div className="mt-5">
            <p className="text-sm font-medium text-slate-500 mb-3">Try a quick prompt:</p>
            <div className="flex flex-wrap justify-center gap-3">
              {(localOnly ? LOCAL_ONLY_QUICK_PROMPTS : quickPrompts).map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => runQuery(prompt)}
                  disabled={isLoading}
                  className="px-4 py-2 rounded-full bg-white border border-slate-200 text-sm text-slate-600 hover:border-purple-400 hover:text-purple-600 hover:shadow-sm disabled:opacity-50 transition-all"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        </motion.div>
      </section>

      {/* Streaming progress (Feature 2) -- shown while a query is in flight,
          replaced by the final Results Section below once "done" arrives. */}
      <AnimatePresence>
        {isLoading && !result && (
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            className="max-w-4xl mx-auto"
          >
            <div className="bg-white rounded-2xl shadow-lg p-8">
              <div className="flex items-center gap-3 mb-4">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-purple-600" />
                </span>
                <h2 className="text-lg font-semibold text-slate-900">
                  {streamStage ? STAGE_LABELS[streamStage] || "Running ensemble..." : "Running ensemble..."}
                </h2>
              </div>
              {streamingAnswer && (
                <div className="prose prose-slate max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingAnswer}</ReactMarkdown>
                </div>
              )}
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {/* Results Section */}
      <AnimatePresence>
        {result && (
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            className="max-w-4xl mx-auto"
          >
            <div className="bg-white rounded-2xl shadow-lg p-8">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-2xl font-bold text-slate-900">Best Answer</h2>
                <span className="px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-sm font-medium">
                  Ensemble Selected
                </span>
              </div>
              <div className="prose prose-slate max-w-none mb-6">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.answer}</ReactMarkdown>
              </div>

              {result.refined_prompt && (
                <p className="text-xs text-slate-500 mb-6 flex items-center gap-1">
                  <Sparkles className="w-3.5 h-3.5 text-purple-500" />
                  Your prompt was automatically optimized before sending it to the providers.
                </p>
              )}

              {/* Compact metrics row - sustainability as small bonus */}
              <div className="pt-6 border-t border-slate-200">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-center">
                  <div>
                    <div className="text-xl font-bold text-purple-600">
                      {(result.metrics.accuracy * 100).toFixed(0)}%
                    </div>
                    <div className="text-xs text-slate-500">Confidence</div>
                  </div>
                  <div>
                    <div className="text-xl font-bold text-blue-600">
                      {result.metrics.latency_s.toFixed(2)}s
                    </div>
                    <div className="text-xs text-slate-500">Latency</div>
                  </div>
                  <div>
                    <div className="text-xl font-bold text-emerald-600">
                      {result.metrics.carbon_saved_g.toFixed(2)}g
                    </div>
                    <div className="text-xs text-slate-500">CO₂ Saved</div>
                  </div>
                  <div>
                    <div className="text-xl font-bold text-orange-600">
                      {result.metrics.emissions_g.toFixed(4)}g
                    </div>
                    <div className="text-xs text-slate-500">Emissions</div>
                  </div>
                  {typeof result.deep_review_confidence === "number" && (
                    <div>
                      <div className="text-xl font-bold text-rose-600">
                        {(result.deep_review_confidence * 100).toFixed(0)}%
                      </div>
                      <div className="text-xs text-slate-500">Deep Review Confidence</div>
                    </div>
                  )}
                  {typeof result.token_savings?.tokens_saved_pct === "number" && (
                    <div>
                      <div className="text-xl font-bold text-indigo-600">
                        {result.token_savings.tokens_saved_pct.toFixed(0)}%
                      </div>
                      <div className="text-xs text-slate-500">Prompt Tokens Saved</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {/* Features Section - Multi-LLM Focus */}
      <section className="py-16">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-slate-900 mb-4">Why MultiLLM?</h2>
          <p className="text-slate-600 max-w-2xl mx-auto">
            Single models hallucinate. Ensembles don&apos;t. We run your prompt across multiple providers and score every response.
          </p>
        </div>
        
        <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {[
            {
              icon: Brain,
              title: "Ensemble Intelligence",
              description: "Run one prompt across OpenAI, Gemini, Mistral, and local models simultaneously"
            },
            {
              icon: Target,
              title: "Automatic Best Selection",
              description: "Source-grounded scoring picks the most accurate, least biased answer every time"
            },
            {
              icon: Layers,
              title: "Multi-Provider Redundancy",
              description: "If one provider fails, the ensemble continues. No single point of failure."
            }
          ].map((feature, index) => {
            const Icon = feature.icon;
            return (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                whileHover={{ scale: 1.05, y: -5 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="bg-white rounded-xl shadow-lg p-6 hover:shadow-xl transition-all"
              >
                <Icon className="w-12 h-12 text-purple-600 mb-4" />
                <h3 className="text-xl font-semibold text-slate-900 mb-2">{feature.title}</h3>
                <p className="text-slate-600">{feature.description}</p>
              </motion.div>
            );
          })}
        </div>
      </section>

      {/* Technical Details */}
      <section className="py-16 bg-slate-50 rounded-2xl">
        <div className="max-w-6xl mx-auto px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-slate-900 mb-4">How It Works</h2>
            <p className="text-slate-600 max-w-2xl mx-auto">
              Transparent ensemble pipeline — you see every candidate, every score, every source.
            </p>
          </div>
          
          <div className="grid md:grid-cols-4 gap-6">
            {[
              { step: "1", title: "Parallel Query", desc: "Your prompt sent to all configured providers at once" },
              { step: "2", title: "Source Retrieval", desc: "Relevant docs fetched per provider for grounding" },
              { step: "3", title: "Multi-Dimensional Scoring", desc: "Source support, bias detection, clarity scored per candidate" },
              { step: "4", title: "Best Answer Returned", desc: "Highest-scoring response delivered with full traceability" }
            ].map((item, index) => (
              <div key={index} className="text-center p-4">
                <div className="w-14 h-14 bg-purple-600 text-white rounded-full flex items-center justify-center mx-auto mb-3 font-bold text-xl">
                  {item.step}
                </div>
                <h3 className="text-lg font-semibold text-slate-900 mb-1">{item.title}</h3>
                <p className="text-sm text-slate-600">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Test Results teaser */}
      <section className="py-16">
        <div className="max-w-4xl mx-auto bg-white rounded-2xl shadow-sm ring-1 ring-slate-100 p-8 text-center">
          <div className="flex items-center justify-center gap-2 mb-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
            <h2 className="text-2xl font-bold text-slate-900">Tested, honestly</h2>
          </div>
          <p className="text-slate-600 max-w-xl mx-auto mb-6">
            76/76 unit tests passing, and a from-scratch-trained scoring model with 0.006 avg. error — plus the
            parts that didn&apos;t come out great, unedited.
          </p>
          <a href="/test-results" className="text-purple-600 font-semibold hover:text-purple-700 inline-flex items-center gap-1">
            See the real numbers <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      </section>

      {/* CTA Section */}
      <section className="text-center py-16 bg-gradient-to-r from-purple-50 to-blue-50 rounded-2xl">
        <h2 className="text-3xl font-bold text-slate-900 mb-4">Stop Guessing. Start Ensembling.</h2>
        <p className="text-slate-600 mb-8 max-w-2xl mx-auto">
          Get better answers by running every prompt across multiple LLMs and automatically selecting the best one.
        </p>
        <a
          href="#try-it"
          className="inline-flex bg-purple-600 hover:bg-purple-700 text-white px-8 py-4 rounded-xl font-semibold transition-colors items-center gap-2 mx-auto"
        >
          Try MultiLLM Free
          <ArrowRight className="w-5 h-5" />
        </a>
        <p className="text-sm text-slate-500 mt-4">
          Free to try, no account needed. Looking at Pro or Enterprise?{" "}
          <a href="/pricing" className="text-purple-600 underline">See pricing</a>.
        </p>
      </section>
    </div>
  );
}