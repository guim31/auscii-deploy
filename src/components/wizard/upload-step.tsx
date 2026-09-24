"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  WrenchIcon,
  RefreshCwIcon,
  FileArchiveIcon,
  InfoIcon,
  Loader2Icon,
  SparklesIcon,
  TriangleAlertIcon,
  UploadCloudIcon,
  XCircleIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fixFormsAction, getAiReportAction, retryAiReportAction } from "@/server/actions/sites";
import { aiReportRetryable } from "@/lib/ai-report";
import type { Analysis } from "@/server/releases/analyze";
import type { AiReport, Finding } from "@/server/providers/types";
import { formatBytes } from "@/server/capacity";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ReleaseView = {
  id: string;
  version: number;
  createdAt: string;
  sizeBytes: number;
  fileCount: number;
  /** Without page texts (analysisForClient). */
  analysis: Analysis | null;
  aiReport: AiReport | null;
  /** Signed preview URL, computed on the server (previewUrl). */
  previewUrl: string;
};

/** Same limit as the server (MAX_ZIP_BYTES), checked before sending. */
const MAX_ZIP_MB = 50;
/** The report usually takes well under a minute; past this, offer to start it again. */
const AI_REPORT_WAIT_MS = 3 * 60_000;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

function IssueIcon({ level }: { level: "error" | "warn" | "info" | "ok" }) {
  if (level === "error") return <XCircleIcon className="text-destructive size-4 shrink-0" />;
  if (level === "warn") return <TriangleAlertIcon className="size-4 shrink-0 text-amber-600" />;
  if (level === "ok") return <CheckCircle2Icon className="text-success size-4 shrink-0" />;
  return <InfoIcon className="text-primary size-4 shrink-0" />;
}

function FindingList({ title, items }: { title: string; items: Finding[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
        {title}
      </div>
      <ul className="flex flex-col gap-1 text-sm">
        {items.map((f, i) => (
          <li key={i} className="flex items-start gap-2">
            <IssueIcon level={f.level} />
            <span>{f.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function UploadStep({
  siteId,
  releases,
  hasInfra,
}: {
  siteId: string;
  releases: ReleaseView[];
  hasInfra: boolean;
}) {
  const [current, setCurrent] = useState<ReleaseView | null>(releases[0] ?? null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // Bumped after an in-place fix so the preview iframe reloads.
  const [previewKey, setPreviewKey] = useState(0);
  // AI reports fetched after the initial render, keyed by release id.
  const [fetchedReports, setFetchedReports] = useState<Record<string, AiReport>>({});
  // Releases whose report did not arrive in time: polling stopped, "Relancer" shown.
  const [reportTimedOut, setReportTimedOut] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const aiReport = current ? (current.aiReport ?? fetchedReports[current.id] ?? null) : null;
  const waitingReport = Boolean(current && !aiReport && !reportTimedOut[current.id]);

  useEffect(() => {
    if (!current || !waitingReport) return;
    const releaseId = current.id;
    const deadline = Date.now() + AI_REPORT_WAIT_MS;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const report = await getAiReportAction(releaseId).catch(() => null);
      if (stop) return;
      if (report) setFetchedReports((prev) => ({ ...prev, [releaseId]: report }));
      else if (Date.now() > deadline) setReportTimedOut((prev) => ({ ...prev, [releaseId]: true }));
      else timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [current, waitingReport]);

  const upload = useCallback(
    (file: File) => {
      if (uploading) return;
      if (!/\.zip$/i.test(file.name)) {
        toast.error("Déposez une archive .zip");
        return;
      }
      if (file.size > MAX_ZIP_MB * 1024 ** 2) {
        toast.error(`Archive trop volumineuse (maximum ${MAX_ZIP_MB} Mo).`);
        return;
      }
      setUploading(true);
      setProgress(0);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/sites/${siteId}/upload`);
      xhr.setRequestHeader("Content-Type", "application/zip");
      xhr.upload.onprogress = (e) =>
        e.lengthComputable && setProgress(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => {
        setUploading(false);
        let body: {
          error?: string;
          releaseId?: string;
          version?: number;
          analysis?: Analysis;
          previewUrl?: string;
        } = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* ignore */
        }
        if (xhr.status >= 400 || !body.releaseId) {
          toast.error(body.error ?? "Échec de l'envoi");
          return;
        }
        toast.success(`Version ${body.version} reçue`);
        setCurrent({
          id: body.releaseId,
          version: body.version!,
          createdAt: new Date().toISOString(),
          sizeBytes: body.analysis?.sizeBytes ?? 0,
          fileCount: body.analysis?.fileCount ?? 0,
          analysis: body.analysis ?? null,
          aiReport: null,
          previewUrl: body.previewUrl ?? "",
        });
      };
      xhr.onerror = () => {
        setUploading(false);
        toast.error("Échec de l'envoi, vérifiez la connexion et réessayez.");
      };
      xhr.send(file);
    },
    [siteId, uploading],
  );

  const analysis = current?.analysis ?? null;
  const unwiredForms =
    analysis?.forms.filter((f) => (f.kind ?? "contact") === "contact" && !f.wired).length ?? 0;

  async function retryReport() {
    if (!current) return;
    setRetrying(true);
    const res = await retryAiReportAction(current.id);
    setRetrying(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success("Nouvelle analyse demandée");
    setFetchedReports((prev) => {
      const next = { ...prev };
      delete next[current.id];
      return next;
    });
    setReportTimedOut((prev) => ({ ...prev, [current.id]: false }));
    setCurrent({ ...current, aiReport: null });
  }

  async function fixFormsNow() {
    if (!current) return;
    setFixing(true);
    const res = await fixFormsAction(current.id);
    setFixing(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success(
      res.fixed > 0
        ? `${plural(res.fixed, "formulaire corrigé", "formulaires corrigés")}`
        : "Aucun formulaire à corriger",
    );
    setCurrent({ ...current, analysis: res.analysis });
    setPreviewKey((k) => k + 1);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Déposer le site</CardTitle>
          <CardDescription>
            Le dossier du site créé avec Claude Code, compressé en .zip (50 Mo max). L'archive est
            vérifiée puis prévisualisée ici avant toute mise en ligne.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            role="button"
            tabIndex={uploading ? -1 : 0}
            aria-disabled={uploading}
            aria-describedby="dropzone-help"
            onClick={() => !uploading && inputRef.current?.click()}
            onKeyDown={(e) => {
              if (uploading || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              inputRef.current?.click();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (!uploading) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file && !uploading) upload(file);
            }}
            className={cn(
              "flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition-colors",
              uploading
                ? "cursor-progress opacity-70"
                : dragging
                  ? "border-primary bg-accent cursor-pointer"
                  : "hover:bg-muted/50 cursor-pointer",
            )}
            data-testid="dropzone"
          >
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              data-testid="zip-input"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Reset so that choosing the same file again triggers a new upload.
                e.target.value = "";
                if (file) upload(file);
              }}
            />
            {uploading ? (
              <Loader2Icon className="text-primary size-8 animate-spin" />
            ) : (
              <UploadCloudIcon className="text-muted-foreground size-8" />
            )}
            <div className="font-medium" aria-live="polite">
              {uploading
                ? progress < 100
                  ? `Envoi… ${progress} %`
                  : "Vérification de l'archive…"
                : "Glissez le .zip ici, ou cliquez pour choisir"}
            </div>
            <div id="dropzone-help" className="text-muted-foreground text-xs">
              Le dossier qui contient index.html, compressé en .zip ({MAX_ZIP_MB} Mo maximum)
            </div>
          </div>
        </CardContent>
      </Card>

      {current && analysis && (
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileArchiveIcon className="size-4" /> Version {current.version}
                  <Badge variant={analysis.ok ? "success" : "destructive"}>
                    {analysis.ok ? "Archive valide" : "Archive incomplète"}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {plural(analysis.fileCount, "fichier", "fichiers")} ·{" "}
                  {formatBytes(analysis.sizeBytes)} ·{" "}
                  {plural(analysis.pages.length, "page", "pages")} · reçue{" "}
                  {formatDateTime(current.createdAt)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-1.5 text-sm" data-testid="analysis-issues">
                  {analysis.issues.length === 0 && (
                    <li className="flex items-center gap-2">
                      <IssueIcon level="ok" /> Aucun point d'attention.
                    </li>
                  )}
                  {analysis.issues.map((issue, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <IssueIcon level={issue.level} />
                      <span>{issue.message}</span>
                    </li>
                  ))}
                </ul>
                {unwiredForms > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={fixFormsNow}
                    disabled={fixing}
                    data-testid="fix-forms"
                  >
                    {fixing ? <Loader2Icon className="animate-spin" /> : <WrenchIcon />} Corriger
                    les formulaires ({unwiredForms})
                  </Button>
                )}
                {analysis.brokenLinks.length > 0 && (
                  <details className="text-muted-foreground mt-3 text-xs">
                    <summary className="cursor-pointer">Voir les liens cassés</summary>
                    <ul className="mt-1 list-disc pl-5">
                      {analysis.brokenLinks.slice(0, 20).map((b, i) => (
                        <li key={i}>
                          {b.page} → {b.href}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <SparklesIcon className="size-4" /> Rapport Claude
                </CardTitle>
                <CardDescription>
                  {aiReport
                    ? aiReport.generatedBy
                    : waitingReport
                      ? "Analyse en cours, vous pouvez continuer sans attendre."
                      : "Le rapport n'est pas arrivé. Vous pouvez le relancer, ou continuer sans."}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {aiReport ? (
                  <>
                    <p className="text-sm">{aiReport.summary}</p>
                    <FindingList title="SEO" items={aiReport.seo} />
                    <FindingList title="Accessibilité" items={aiReport.accessibility} />
                    <FindingList title="Contenu" items={aiReport.content} />
                    {aiReportRetryable(aiReport.generatedBy) && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={retryReport}
                        disabled={retrying}
                        data-testid="retry-ai-report"
                      >
                        {retrying ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}{" "}
                        Relancer l'analyse
                      </Button>
                    )}
                  </>
                ) : waitingReport ? (
                  <div
                    className="text-muted-foreground flex items-center gap-2 text-sm"
                    role="status"
                  >
                    <Loader2Icon className="size-4 animate-spin" /> Lecture des pages…
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={retryReport}
                    disabled={retrying}
                    data-testid="retry-ai-report"
                  >
                    {retrying ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}{" "}
                    Relancer l'analyse
                  </Button>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="gap-0 overflow-hidden py-0">
            <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
              <span className="font-medium">Prévisualisation</span>
              {current.previewUrl && (
                <a
                  href={current.previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary text-xs hover:underline"
                >
                  Ouvrir dans un onglet
                </a>
              )}
            </div>
            {current.previewUrl ? (
              <iframe
                key={previewKey}
                src={current.previewUrl}
                title="Prévisualisation du site"
                className="h-[560px] w-full bg-white"
                sandbox="allow-scripts allow-forms allow-popups allow-modals"
                referrerPolicy="no-referrer"
                data-testid="preview-frame"
              />
            ) : (
              <div className="text-muted-foreground flex h-[560px] items-center justify-center p-6 text-sm">
                Rechargez la page pour afficher la prévisualisation.
              </div>
            )}
          </Card>
        </div>
      )}

      <div className="flex items-center justify-between">
        {releases.length > 1 && current && (
          <div className="text-muted-foreground text-xs">
            Versions précédentes :{" "}
            {releases
              .filter((r) => r.id !== current.id)
              .map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="mr-2 underline"
                  onClick={() => setCurrent(r)}
                >
                  v{r.version}
                </button>
              ))}
          </div>
        )}
        <Button
          size="lg"
          asChild
          disabled={!current || !analysis?.ok}
          className={cn("ml-auto", (!current || !analysis?.ok) && "pointer-events-none opacity-50")}
          data-testid="go-step-4"
        >
          <Link
            href={current && analysis?.ok ? `/deploy/${siteId}/step-4?release=${current.id}` : "#"}
          >
            {hasInfra ? "Continuer vers la mise en ligne" : "Continuer"} <ArrowRightIcon />
          </Link>
        </Button>
      </div>
    </div>
  );
}
