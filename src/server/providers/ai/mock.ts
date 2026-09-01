import type { AiProvider, AiReport, AiSiteInput, Finding } from "../types";
import { sleep } from "../mock-utils";

/** Heuristic report, no network. Good enough to demo the shape of the real Claude report. */
export class MockAiProvider implements AiProvider {
  readonly name = "mock-claude";

  async analyzeSite(input: AiSiteInput): Promise<AiReport> {
    await sleep(2500);
    const seo: Finding[] = [];
    const accessibility: Finding[] = [];
    const content: Finding[] = [];

    const untitled = input.pages.filter((p) => !p.title);
    if (untitled.length)
      seo.push({
        level: "warn",
        message: `${untitled.length} page(s) sans balise <title> : ${untitled
          .map((p) => p.path)
          .slice(0, 3)
          .join(", ")}`,
      });
    else seo.push({ level: "ok", message: "Toutes les pages ont un titre." });

    const thin = input.pages.filter((p) => p.text.trim().split(/\s+/).length < 80);
    if (thin.length)
      seo.push({
        level: "info",
        message: `${thin.length} page(s) avec peu de texte (moins de 80 mots).`,
      });

    const totalWords = input.pages.reduce(
      (n, p) => n + p.text.trim().split(/\s+/).filter(Boolean).length,
      0,
    );
    content.push({
      level: "info",
      message: `${input.pages.length} page(s), environ ${totalWords} mots au total.`,
    });
    const mentionsClient = input.pages.some((p) =>
      p.text.toLowerCase().includes(input.clientName.toLowerCase().split(" ")[0]),
    );
    content.push(
      mentionsClient
        ? {
            level: "ok",
            message: `Le nom du client (${input.clientName}) apparaît dans le contenu.`,
          }
        : {
            level: "warn",
            message: `Le nom du client (${input.clientName}) n'apparaît pas dans le texte des pages.`,
          },
    );
    const hasContact = input.pages.some((p) => /contact/i.test(p.text) || /contact/i.test(p.path));
    content.push(
      hasContact
        ? { level: "ok", message: "Une section ou page de contact est présente." }
        : { level: "info", message: "Aucune mention de contact trouvée." },
    );

    accessibility.push({
      level: "info",
      message:
        "Vérifiez le contraste des couleurs et la présence d'attributs alt sur les images (voir l'analyse automatique).",
    });
    accessibility.push({ level: "ok", message: "Structure HTML analysée sans erreur bloquante." });

    const warnCount = [...seo, ...accessibility, ...content].filter(
      (f) => f.level === "warn",
    ).length;
    const summary =
      warnCount === 0
        ? "Le site est prêt pour la préproduction. Aucun point bloquant relevé."
        : `Le site peut partir en préproduction. ${warnCount} point(s) à corriger avant la mise en production idéalement.`;

    return { summary, seo, accessibility, content, generatedBy: "Analyse locale (mode démo)" };
  }
}
