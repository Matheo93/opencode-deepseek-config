import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

/**
 * x — recherche de posts X via l'Agent Tools API de xAI (Grok).
 *
 * Deux methodes avec la cle xAI :
 *  1. "ask LLM"  : tu poses une question, Grok cherche X et te digere la reponse.
 *  2. "je cherche moi-meme" (ce tool) : tu passes TA query, on force x_keyword_search
 *     / x_semantic_search, et on te rend les POSTS BRUTS (liens x.com/.../status/).
 *     Tu ouvres ensuite ceux qui t'interessent avec browser_open pour lire l'outil.
 *
 * Verifie live 2026-07 : `POST https://api.x.ai/v1/responses` avec
 * `tools:[{type:"x_search"}]`. L'ancien `search_parameters` (live search) est
 * DEPRECATED cote xAI -> ne pas l'utiliser.
 *
 * Cle : process.env.XAI_API_KEY (jamais en dur, jamais dans LESSONS.md).
 */

const ENDPOINT = "https://api.x.ai/v1/responses"

function extractUrls(json: string): string[] {
  const m = json.match(/https?:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/[0-9]+/g) || []
  // aussi les liens x.com/i/status/<id> (auteur masque)
  const m2 = json.match(/https?:\/\/(?:x|twitter)\.com\/i\/status\/[0-9]+/g) || []
  return [...new Set([...m, ...m2])]
}

function walkText(output: unknown): string {
  const out: string[] = []
  const arr = Array.isArray(output) ? output : []
  for (const item of arr as Array<{ content?: Array<{ type?: string; text?: string }> }>) {
    for (const c of item.content || []) if (c.type === "output_text" && c.text) out.push(c.text)
  }
  return out.join("\n").trim()
}

function walkQueries(output: unknown): string[] {
  const arr = Array.isArray(output) ? output : []
  return (arr as Array<{ type?: string; name?: string; input?: string }>)
    .filter((i) => i.type === "custom_tool_call")
    .map((i) => `${i.name}(${i.input})`)
}

export const XSearch: Plugin = async () => ({
  tool: {
    x_search: tool({
      description:
        "Cherche des POSTS X (Twitter) sur une query et retourne les posts bruts + leurs liens (methode 'je cherche moi-meme', pas de reponse machee). Utilise l'Agent Tools API de xAI/Grok (x_keyword_search/x_semantic_search). Ensuite ouvre les liens interessants avec browser_open pour lire l'outil/le contenu. Requiert XAI_API_KEY dans l'env.",
      args: {
        query: tool.schema.string().describe("ce que tu cherches sur X (ex: 'outil MCP pour opencode', 'plugin @unmec ...')"),
        mode: tool.schema.string().optional().describe("'Latest' (recents, defaut) ou 'Top' (populaires)"),
        limit: tool.schema.number().optional().describe("nb de posts (defaut 15)"),
        from_date: tool.schema.string().optional().describe("date min YYYY-MM-DD (optionnel)"),
      },
      async execute(args, ctx) {
        const key = process.env.XAI_API_KEY
        if (!key) throw new Error("XAI_API_KEY absent de l'env. Mets ta cle xAI en variable d'env (jamais en dur).")
        const mode = args.mode || "Latest"
        const limit = args.limit || 15
        const instr =
          `Utilise x_keyword_search en mode ${mode}, limit ${limit}${args.from_date ? `, from_date ${args.from_date}` : ""}, ` +
          `pour trouver des posts X correspondant a: "${args.query}". ` +
          `Rends les posts BRUTS, un par ligne: @auteur | texte court | lien du post | date. Pas d'analyse, juste la liste.`
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "grok-4.3", input: instr, tools: [{ type: "x_search" }] }),
          signal: ctx.abort,
        })
        const raw = await res.text()
        if (!res.ok) throw new Error(`xAI ${res.status}: ${raw.slice(0, 300)}`)
        let parsed: { output?: unknown } = {}
        try { parsed = JSON.parse(raw) } catch {}
        const urls = extractUrls(raw)
        const text = walkText(parsed.output)
        const queries = walkQueries(parsed.output)
        return {
          title: `x_search: ${urls.length} posts`,
          output: JSON.stringify(
            { query: args.query, searched: queries, posts_text: text || "(pas de texte structure — voir les liens)", post_urls: urls },
            null,
            2,
          ),
          metadata: { posts: urls.length },
        }
      },
    }),
  },
})
