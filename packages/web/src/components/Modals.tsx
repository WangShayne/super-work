import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { OperatingMode, PipelineTemplateId, WorkerEngineId } from "../types.ts";

interface DispatchModalProps {
  open: boolean;
  availableEngines: WorkerEngineId[];
  defaultTemplate: PipelineTemplateId;
  defaultEngine: WorkerEngineId;
  onClose: () => void;
  onSubmit: (data: {
    title: string;
    description: string;
    template: PipelineTemplateId;
    allowedPaths: string[];
    preferredEngine: WorkerEngineId;
    maxCostUsd: number;
  }) => Promise<void>;
}

export function DispatchTaskModal({
  open,
  availableEngines,
  defaultTemplate,
  defaultEngine,
  onClose,
  onSubmit,
}: DispatchModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState<PipelineTemplateId>(defaultTemplate);
  const [paths, setPaths] = useState("**");
  const [engine, setEngine] = useState<WorkerEngineId>(defaultEngine);
  const [budget, setBudget] = useState("2.0");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setTemplate(defaultTemplate);
      setEngine(defaultEngine);
    }
  }, [open, defaultTemplate, defaultEngine]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim(),
        template,
        allowedPaths: paths
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        preferredEngine: engine,
        maxCostUsd: Number(budget) || 2.0,
      });
      setTitle("");
      setDescription("");
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">Dispatch Task</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div>
            <label className="block text-zinc-400 mb-1">Task Title</label>
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Add rate limiter middleware"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">Goal & Acceptance Instructions</label>
            <textarea
              required
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe expected behavior and verification..."
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-zinc-400 mb-1">Pipeline</label>
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value as PipelineTemplateId)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              >
                <option value="fast">fast</option>
                <option value="standard">standard</option>
                <option value="strict">strict</option>
              </select>
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">Worker Engine</label>
              <select
                value={engine}
                onChange={(e) => setEngine(e.target.value as WorkerEngineId)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              >
                {availableEngines.map((eng) => (
                  <option key={eng} value={eng}>
                    {eng}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">Max Budget ($)</label>
              <input
                type="number"
                step="0.25"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              />
            </div>
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">Mandate Allowed Paths (comma-separated)</label>
            <input
              value={paths}
              onChange={(e) => setPaths(e.target.value)}
              placeholder="packages/core/**, packages/drivers/**"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50"
            >
              {submitting ? "Dispatching..." : "Dispatch"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface SimulateModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: {
    source: "github_issue" | "github_pr" | "github_ci" | "cli";
    threadKey: string;
    title: string;
    rawText: string;
  }) => Promise<void>;
}

export function SimulateEventModal({ open, onClose, onSubmit }: SimulateModalProps) {
  const [source, setSource] = useState<"github_issue" | "github_pr" | "github_ci" | "cli">(
    "github_issue",
  );
  const [threadKey, setThreadKey] = useState(`gh:issue:${Math.floor(100 + Math.random() * 899)}`);
  const [title, setTitle] = useState("");
  const [rawText, setRawText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !rawText.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit({
        source,
        threadKey: threadKey.trim(),
        title: title.trim(),
        rawText: rawText.trim(),
      });
      setTitle("");
      setRawText("");
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">Simulate External Event</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-[11px] text-zinc-400">
          Test Router triage, <code className="text-amber-300">observe</code> vs{" "}
          <code className="text-emerald-300">auto</code> gating, and Thread Subscription routing without waiting for external GitHub webhooks.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-400 mb-1">Source</label>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as typeof source)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              >
                <option value="github_issue">github_issue</option>
                <option value="github_pr">github_pr</option>
                <option value="github_ci">github_ci</option>
                <option value="cli">cli</option>
              </select>
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">Thread Key</label>
              <input
                required
                value={threadKey}
                onChange={(e) => setThreadKey(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
              />
            </div>
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">Event Title</label>
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. #42 CI failed on auth middleware"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
            />
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">Event Body (supports scope:path/**)</label>
            <textarea
              required
              rows={3}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder="Describe bug report or CI failure. Use scope:src/auth/** to hint Mandate."
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-medium disabled:opacity-50"
            >
              {submitting ? "Sending..." : "Emit Trigger"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface AddRepoModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: {
    name: string;
    rootPath: string;
    baseBranch: string;
    githubRepo?: string;
    mode: OperatingMode;
  }) => Promise<void>;
}

export function AddRepoModal({ open, onClose, onSubmit }: AddRepoModalProps) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [githubRepo, setGithubRepo] = useState("");
  const [mode, setMode] = useState<OperatingMode>("observe");
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !rootPath.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        rootPath: rootPath.trim(),
        baseBranch: baseBranch.trim() || "main",
        githubRepo: githubRepo.trim() || undefined,
        mode,
      });
      setName("");
      setRootPath("");
      setGithubRepo("");
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">Register Git Repository</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3 text-xs">
          <div>
            <label className="block text-zinc-400 mb-1">Display Name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-service"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-100"
            />
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">Local Repository Path</label>
            <input
              required
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              placeholder="/Users/you/work/my-service"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-400 mb-1">Base Branch</label>
              <input
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-zinc-400 mb-1">Initial Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as OperatingMode)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-2 text-zinc-100"
              >
                <option value="observe">observe</option>
                <option value="auto">auto</option>
                <option value="off">off</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-zinc-400 mb-1">GitHub Repo (optional, owner/repo)</label>
            <input
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              placeholder="owner/repo"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-zinc-100"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-zinc-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50"
            >
              Register
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
