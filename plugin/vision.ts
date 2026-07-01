import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { createWorker } from "tesseract.js"

/**
 * vision — OCR des images pour opencode, SANS sudo et SANS modele vision.
 *
 * Probleme : DeepSeek (le modele) n'a pas de vision -> une image collee
 * (screenshot d'un form, d'une erreur, d'une UI) est illisible pour lui.
 *
 * Fix : tesseract.js (WASM pur, npm, aucun binaire systeme, aucun root). Les
 * donnees de langue se telechargent en cache au 1er run. Rend le TEXTE de
 * l'image -> exploitable par un modele texte. Limite honnete : c'est de l'OCR
 * (texte dans l'image), pas de la comprehension de photo/diagramme.
 *
 * L'agent recoit une image collee comme FilePart {mime:"image/*", url}. Il
 * passe cet url (data:, file://, http, ou chemin) a image_read.
 */

// worker reutilise entre appels (le charger coute ~1s)
let worker: Awaited<ReturnType<typeof createWorker>> | null = null
let workerLang = ""

async function getWorker(lang: string) {
  if (worker && workerLang === lang) return worker
  if (worker) { try { await worker.terminate() } catch {} }
  worker = await createWorker(lang)
  workerLang = lang
  return worker
}

export const Vision: Plugin = async () => ({
  dispose: async () => { try { await worker?.terminate() } catch {} worker = null },
  tool: {
    image_read: tool({
      description:
        "Lit le TEXTE d'une image par OCR (screenshot, photo de document, capture d'erreur/formulaire). A appeler quand une image est collee et que tu ne peux pas la lire : passe le chemin, l'url (data:/file:///http) ou le filename de l'image. Retourne le texte extrait. Limite: OCR de texte, pas de comprehension de scene.",
      args: {
        src: tool.schema.string().describe("chemin fichier, data-URL, file:// ou http(s) de l'image"),
        lang: tool.schema.string().optional().describe("langues OCR (defaut 'fra+eng'; ex: 'eng', 'deu+eng')"),
      },
      async execute(args) {
        const lang = args.lang || "fra+eng"
        const w = await getWorker(lang)
        const { data } = await w.recognize(args.src)
        const text = (data.text || "").trim()
        return {
          title: `OCR: ${text.length} chars (conf ${Math.round(data.confidence)}%)`,
          output: text || "(aucun texte detecte dans l'image)",
          metadata: { chars: text.length, confidence: data.confidence, lang },
        }
      },
    }),
  },
})
