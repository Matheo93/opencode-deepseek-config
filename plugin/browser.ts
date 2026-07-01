import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import puppeteer, { type Browser, type Page } from "puppeteer-core"
import { readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * browser — pilotage d'un vrai Chrome pour opencode, SANS sudo.
 *
 * Constat (verifie live) : Chrome for Testing est deja installe dans
 * ~/.cache/puppeteer/chrome/ (telecharge par puppeteer, aucun root requis) et
 * toutes les libs .so sont presentes. Le "Chrome pas installable" est faux.
 *
 * Design pour un modele SANS vision (DeepSeek) : les tools ne rendent pas des
 * screenshots (illisibles pour un modele texte) mais un SNAPSHOT TEXTE de la
 * page = texte visible + liste numerotee des elements interactifs (liens,
 * boutons, champs). On clique/remplit par [ref] numerique. C'est ce qui rend
 * un navigateur exploitable par un LLM texte (meme principe que Playwright MCP).
 *
 * Etat partage (browser/page) au niveau module -> persiste entre les tool calls
 * d'une meme session. Ferme au dispose. Pas d'eval JS arbitraire (surface
 * d'injection depuis une page hostile) : extraction par selecteur CSS typé.
 */

const HOME = process.env.HOME || "."

function chromePath(): string {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) return process.env.PUPPETEER_EXECUTABLE_PATH
  const base = join(HOME, ".cache", "puppeteer", "chrome")
  const dirs = readdirSync(base).filter((d) => d.startsWith("linux-"))
  const num = (d: string) => d.replace("linux-", "").split(".").map(Number)
  dirs.sort((a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 4; i++) if ((y[i] || 0) !== (x[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0 })
  if (!dirs.length) throw new Error(`aucun chrome dans ${base} (lance: npx @puppeteer/browsers install chrome@stable)`)
  return join(base, dirs[0], "chrome-linux64", "chrome")
}

let browser: Browser | null = null
let page: Page | null = null

async function getPage(): Promise<Page> {
  if (browser && page && !page.isClosed()) return page
  browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--window-size=1366,900"],
  })
  page = await browser.newPage()
  await page.setViewport({ width: 1366, height: 900 })
  return page
}

// snapshot texte : url, titre, texte visible tronque, elements interactifs numerotes [ref]
async function snapshot(p: Page): Promise<{ url: string; title: string; text: string; elements: string[] }> {
  return await p.evaluate(() => {
    const sel = "a,button,input,textarea,select,[role=button],[role=link],[onclick]"
    const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[]
    const elements: string[] = []
    els.forEach((el, i) => {
      el.setAttribute("data-oc-ref", String(i))
      const tag = el.tagName.toLowerCase()
      const anyEl = el as HTMLInputElement
      const label = (el.innerText || anyEl.value || anyEl.placeholder || el.getAttribute("aria-label") || anyEl.name || "").trim().replace(/\s+/g, " ").slice(0, 70)
      const extra = tag === "a" ? (el.getAttribute("href") || "").slice(0, 60) : tag === "input" ? anyEl.type : ""
      const rect = el.getBoundingClientRect()
      if ((label || extra) && rect.width > 0 && rect.height > 0) elements.push(`[${i}] ${tag}${extra ? `(${extra})` : ""} ${label}`)
    })
    return { url: location.href, title: document.title, text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 3500), elements: elements.slice(0, 120) }
  })
}

const asResult = (snap: Awaited<ReturnType<typeof snapshot>>, note = "") => ({
  title: `${snap.title || snap.url}`.slice(0, 60),
  output: `${note ? note + "\n" : ""}URL: ${snap.url}\nTITRE: ${snap.title}\n\n--- ELEMENTS INTERACTIFS (clique/remplis par [ref]) ---\n${snap.elements.join("\n") || "(aucun)"}\n\n--- TEXTE VISIBLE ---\n${snap.text}`,
  metadata: { url: snap.url, elements: snap.elements.length },
})

export const BrowserTools: Plugin = async () => ({
  dispose: async () => { try { await browser?.close() } catch {} browser = null; page = null },
  tool: {
    browser_open: tool({
      description: "Ouvre une URL dans un vrai Chrome (headless, sans sudo) et retourne un SNAPSHOT TEXTE : titre, texte visible, et la liste numerotee des elements interactifs. Le navigateur reste ouvert entre les tool calls.",
      args: { url: tool.schema.string().describe("URL a ouvrir (https://...)"), wait: tool.schema.string().optional().describe("selector CSS a attendre avant snapshot (optionnel)") },
      async execute(args) {
        const p = await getPage()
        await p.goto(args.url.startsWith("http") ? args.url : `https://${args.url}`, { waitUntil: "domcontentloaded", timeout: 45_000 })
        if (args.wait) await p.waitForSelector(args.wait, { timeout: 15_000 }).catch(() => {})
        return asResult(await snapshot(p))
      },
    }),

    browser_read: tool({
      description: "Re-lit la page courante : snapshot texte a jour (apres un chargement dynamique, un scroll, une action JS). N'ouvre rien de nouveau.",
      args: {},
      async execute() {
        if (!page) throw new Error("aucune page ouverte : lance browser_open d'abord")
        return asResult(await snapshot(page))
      },
    }),

    browser_click: tool({
      description: "Clique un element de la page courante, par [ref] numerique du dernier snapshot, ou par selector CSS, ou par texte. Retourne le snapshot resultant.",
      args: { ref: tool.schema.string().describe("un numero de [ref] (ex: '12'), un selector CSS, ou 'text=Connexion'") },
      async execute(args) {
        const p = page || (await getPage())
        const r = args.ref.trim()
        if (r.startsWith("text=")) {
          const t = r.slice(5)
          const handles = await p.$$("a,button,[role=button],input,[onclick]")
          let done = false
          for (const el of handles) {
            const tx = (await p.evaluate((e: Element) => (e as HTMLElement).innerText || (e as HTMLInputElement).value || "", el)).trim()
            if (tx.includes(t)) { await el.click().catch(() => {}); done = true; break }
          }
          if (!done) throw new Error(`aucun element avec le texte "${t}"`)
        } else {
          const sel = /^\d+$/.test(r) ? `[data-oc-ref="${r}"]` : r
          await p.click(sel, { timeout: 10_000 })
        }
        await p.waitForNetworkIdle({ idleTime: 800, timeout: 8_000 }).catch(() => {})
        return asResult(await snapshot(p), `clique: ${r}`)
      },
    }),

    browser_type: tool({
      description: "Remplit un champ (input/textarea) par [ref] ou selector, puis optionnellement soumet (Enter). Retourne le snapshot resultant.",
      args: {
        ref: tool.schema.string().describe("[ref] numerique ou selector CSS du champ"),
        text: tool.schema.string().describe("texte a saisir"),
        submit: tool.schema.boolean().optional().describe("appuyer Entree apres (defaut false)"),
      },
      async execute(args) {
        const p = page || (await getPage())
        const sel = /^\d+$/.test(args.ref.trim()) ? `[data-oc-ref="${args.ref.trim()}"]` : args.ref
        await p.click(sel, { timeout: 10_000 })
        await p.$eval(sel, (el) => ((el as HTMLInputElement).value = "")).catch(() => {})
        await p.type(sel, args.text, { delay: 15 })
        if (args.submit) { await p.keyboard.press("Enter"); await p.waitForNetworkIdle({ idleTime: 800, timeout: 8_000 }).catch(() => {}) }
        return asResult(await snapshot(p), `saisi dans ${args.ref}${args.submit ? " + submit" : ""}`)
      },
    }),

    browser_extract: tool({
      description: "Extrait des donnees de la page courante par selecteur CSS (sans executer de JS arbitraire). Retourne pour chaque match: texte + href + valeur d'un attribut optionnel. Pour recolter une liste (titres, prix, liens...).",
      args: {
        selector: tool.schema.string().describe("selecteur CSS (ex: 'h2.title', 'a.result', '.price')"),
        attr: tool.schema.string().optional().describe("attribut a lire en plus (ex: 'href', 'data-id', 'src')"),
      },
      async execute(args) {
        const p = page || (await getPage())
        const rows = await p.$$eval(args.selector, (els, attr) => els.slice(0, 200).map((el) => {
          const h = el as HTMLElement
          return { text: (h.innerText || "").trim().replace(/\s+/g, " ").slice(0, 200), href: (el as HTMLAnchorElement).href || undefined, attr: attr ? el.getAttribute(attr) || undefined : undefined }
        }), args.attr ?? "")
        return { title: `extract: ${rows.length}`, output: JSON.stringify({ selector: args.selector, count: rows.length, rows }, null, 2), metadata: { count: rows.length } }
      },
    }),

    browser_screenshot: tool({
      description: "Capture un PNG de la page courante (pour archive ou pour qu'un modele vision le lise). Retourne le chemin du fichier.",
      args: { full: tool.schema.boolean().optional().describe("pleine page (defaut: viewport)") },
      async execute(args) {
        if (!page) throw new Error("aucune page ouverte")
        const path = join(tmpdir(), `oc-shot-${Date.now()}.png`)
        await page.screenshot({ path: path as `${string}.png`, fullPage: !!args.full })
        return { title: "screenshot", output: `PNG sauve: ${path}`, metadata: { path }, attachments: [{ type: "file" as const, mime: "image/png", url: `file://${path}`, filename: "page.png" }] }
      },
    }),
  },
})
