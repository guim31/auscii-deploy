"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRightIcon,
  CheckCircle2Icon,
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
import { getAiReportAction } from "@/server/actions/sites";
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
  analysis: Analysis | null;
  aiReport: AiReport | null;
};

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
  // AI reports fetched after the initial render, keyed by release id.
  const [fetchedReports, setFetchedReports] = useState<Record<string, AiReport>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const aiReport = current ? (current.aiReport ?? fetchedReports[current.id] ?? null) : null;

  useEffect(() => {
    if (!current || current.aiReport || fetchedReports[current.id]) return;
    const releaseId = current.id;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const report = await getAiReportAction(releaseId);
      if (stop) return;
      if (report) setFetchedReports((prev) => ({ ...prev, [releaseId]: report }));
      else timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [current, fetchedReports]);

  const upload = useCallback(
    (file: File) => {
      if (!/\.zip$/i.test(file.name)) {
        toast.error("Déposez une archive .zip");
        return;
      }
      setUploading(true);
      setProgress(0);
      const form = new FormData();
      form.append("file", file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/sites/${siteId}/upload`);
      xhr.upload.onprogress = (e) =>
        e.lengthComputable && setProgress(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => {
        setUploading(false);
        let body: { error?: string; releaseId?: string; version?: number; analysis?: Analysis } =
          {};
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
        });
      };
      xhr.onerror = () => {
        setUploading(false);
        toast.error("Échec de l'envoi");
      };
      xhr.send(form);
    },
    [siteId],
  );

  const analysis = current?.analysis ?? null;

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
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) upload(file);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition-colors",
              dragging ? "border-primary bg-accent" : "hover:bg-muted/50",
            )}
            data-testid="dropzone"
          >
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              data-testid="zip-input"
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
            {uploading ? (
              <Loader2Icon className="text-primary size-8 animate-spin" />
            ) : (
              <UploadCloudIcon className="text-muted-foreground size-8" />
            )}
            <div className="font-medium">
              {uploading ? `Envoi… ${progress} %` : "Glissez le .zip ici, ou cliquez pour choisir"}
            </div>
            <div className="text-muted-foreground text-xs">
              index.html à la racine, ou dans un dossier unique
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
                  {analysis.fileCount} fichiers · {formatBytes(analysis.sizeBytes)} ·{" "}
                  {analysis.pages.length} page(s) HTML · reçue {formatDateTime(current.createdAt)}
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
                {analysis.brokenLinks.length > 0 && (
                  <details className="text-muted-foreground mt-3 text-xs">
                    <summary className="cursor-pointer">Liens cassés</summary>
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
                    : "Analyse en cours, vous pouvez continuer sans attendre."}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {aiReport ? (
                  <>
                    <p className="text-sm">{aiReport.summary}</p>
                    <FindingList title="SEO" items={aiReport.seo} />
                    <FindingList title="Accessibilité" items={aiReport.accessibility} />
                    <FindingList title="Contenu" items={aiReport.content} />
                  </>
                ) : (
                  <div className="text-muted-foreground flex items-center gap-2 text-sm">
                    <Loader2Icon className="size-4 animate-spin" /> Lecture des pages…
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="gap-0 overflow-hidden py-0">
            <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
              <span className="font-medium">Prévisualisation</span>
              <a
                href={`/api/preview/${current.id}/`}
                target="_blank"
                rel="noreferrer"
                className="text-primary text-xs hover:underline"
              >
                Ouvrir dans un onglet
              </a>
            </div>
            <iframe
              src={`/api/preview/${current.id}/`}
              title="Prévisualisation du site"
              className="h-[560px] w-full bg-white"
              sandbox="allow-same-origin allow-scripts allow-forms"
              data-testid="preview-frame"
            />
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
