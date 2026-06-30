import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, appendFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * longmem — memoire longue persistante pour opencode.
 *
 * Probleme resolu : opencode repart sans memoire, et meme intra-session une
 * correction se noie 3 messages plus loin (compaction, dilution du contexte).
 *
 * Mecanisme (3 hooks) :
 *  1. chat.message            -> capture les corrections de l'utilisateur dans LESSONS.md
 *  2. chat.system.transform   -> reinjecte les lecons dans le system prompt A CHAQUE TOUR
 *  3. session.compacting      -> fait survivre les lecons a la compaction
 *
 * Capture :
 *  - EXPLICITE  : un message qui commence par "#mem ", "#regle ", "#lesson "
 *                 -> le reste est persiste verbatim, priorite haute.
 *  - IMPLICITE  : un message contenant un marqueur de correction/frustration
 *                 -> persiste comme lecon candidate (l'agent la voit ensuite).
 */

const HOME = process.env.HOME || process.env.USERPROFILE || "."
const MEM_DIR = join(HOME, ".config", "opencode", "memory")
const LESSONS = join(MEM_DIR, "LESSONS.md")

// Marqueurs de correction (FR). Signal haute densite : quand Matheo dit ca,
// c'est qu'une regle vient d'etre violee. On capture le message comme lecon.
const CORRECTION = new RegExp(
  [
    "\\bnon\\b", "arr[eê]te", "refais", "recommence", "c'?est faux", "c'?est pas (ca|bon)",
    "je t'?ai dit", "d[eé]j[aà] dit", "encore une fois", "tu (re)?fais",
    "pas (ca|comme ca|de cette)", "tu d[eé]cr[eè]te", "nargue", "fdp", "ta gueule",
    "tu defie", "tu m'?as pas [eé]cout", "combien de fois", "putain", "bordel",
  ].join("|"),
  "i",
)
const EXPLICIT = /^\s*#(mem|regle|règle|lesson|lecon|leçon|rule)\b[:\s]+/i

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()

function ensureFile() {
  if (!existsSync(LESSONS)) {
    writeFileSync(
      LESSONS,
      "# LESSONS — memoire longue opencode\n" +
        "> Corrections passees. Reinjectees dans le system a chaque tour. Edite a la main si besoin.\n\n",
    )
  }
}

function existing(): string[] {
  ensureFile()
  return readFileSync(LESSONS, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.replace(/^- (\[[^\]]*\]\s*)?/, ""))
}

function addLesson(text: string, kind: "REGLE" | "correction") {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 400)
  if (clean.length < 4) return
  const already = existing().some((e) => norm(e).includes(norm(clean)) || norm(clean).includes(norm(e)))
  if (already) return
  ensureFile()
  const tag = kind === "REGLE" ? "[REGLE]" : "[corr]"
  appendFileSync(LESSONS, `- ${tag} ${clean}\n`)
}

function textOf(parts: Array<{ type?: string; text?: string }>): string {
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim()
}

function recall(maxChars = 4000): string {
  const all = existing()
  if (!all.length) return ""
  // les plus recentes d'abord, plafonnees en taille
  const picked: string[] = []
  let size = 0
  for (const l of all.slice().reverse()) {
    if (size + l.length > maxChars) break
    picked.push(l)
    size += l.length
  }
  return picked.reverse().map((l) => `- ${l}`).join("\n")
}

// --- auto-critique cross-model : flash (cross-model de pro) extrait une lecon ---
const turn = new Map<string, { user: string; assistant: string }>()

async function critique(user: string, assistant: string) {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key || !assistant) return
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        thinking: { type: "disabled" },
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content:
              "Tu es un evaluateur en fresh context pour un operateur redteam/devops. On te donne UN echange utilisateur/operateur. " +
              "Reponds UNE ligne prefixee 'LESSON: ' si l'echange contient l'un de:\n" +
              "- une correction/rejet de l'utilisateur (a ne pas refaire),\n" +
              "- un FAIT D'INFRA reutilisable: port, host/IP, version, seuil de charge, ce qui sature/meurt, ce qui marche ou echoue, credential-location,\n" +
              "- une regle de methode imposee.\n" +
              "Sinon (bavardage, accuse de reception, action banale sans enseignement) reponds exactement 'NONE'. " +
              "La LESSON doit etre dense et actionnable, pas une paraphrase polie.",
          },
          { role: "user", content: `[UTILISATEUR]\n${user}\n\n[OPERATEUR]\n${assistant}` },
        ],
      }),
    })
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const out = (j.choices?.[0]?.message?.content ?? "").trim()
    const m = out.match(/^LESSON:\s*(.+)/is)
    if (m) addLesson(m[1], "correction")
  } catch {
    /* offline / quota: on n'echoue jamais le tour */
  }
}

export const LongMem: Plugin = async () => {
  const pending = new Map<string, { user: string; assistant: string }>() // tours fini, a critiquer

  return {
    // opencode attend dispose() a l'arret -> les critiques async ont le temps de finir
    dispose: async () => {
      for (const t of pending.values()) await critique(t.user, t.assistant)
      pending.clear()
    },

    "chat.message": async (input, output) => {
      const sid = input.sessionID
      // tour precedent complet pour cette session -> le faire juger par flash
      const prev = sid ? turn.get(sid) : undefined
      if (prev && prev.assistant) await critique(prev.user, prev.assistant)

      const raw = textOf(output.parts as Array<{ type?: string; text?: string }>)
      if (!raw) return
      // strip guillemets / backticks d'enrobage avant de tester les marqueurs
      const txt = raw.replace(/^["'`\s]+/, "").replace(/["'`\s]+$/, "")
      if (sid) turn.set(sid, { user: txt, assistant: "" })
      if (EXPLICIT.test(txt)) {
        addLesson(txt.replace(EXPLICIT, ""), "REGLE")
      } else if (CORRECTION.test(txt)) {
        addLesson(txt, "correction")
      }
    },

    "experimental.text.complete": async (input, output) => {
      const t = input.sessionID ? turn.get(input.sessionID) : undefined
      if (t) t.assistant = (t.assistant + "\n" + (output.text || "")).trim()
    },

    event: async (input) => {
      // fin de session (mode run one-shot) -> juger le dernier echange en attente
      const ev = input.event as { type?: string; properties?: { sessionID?: string } }
      if (ev?.type === "session.idle" || ev?.type === "session.last") {
        const sid = ev.properties?.sessionID
        const t = sid ? turn.get(sid) : undefined
        if (sid && t && t.assistant) {
          pending.set(sid, { ...t }) // critique() au dispose (sinon le process exit tue le fetch)
          turn.delete(sid)
        }
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const mem = recall()
      if (!mem) return
      output.system.push(
        "## MEMOIRE LONGUE — corrections et regles passees de l'utilisateur\n" +
          "Tu les a deja violees une fois. Ne les refais pas. Les [REGLE] sont imperatives.\n" +
          mem,
      )
    },

    "experimental.session.compacting": async (_input, output) => {
      const mem = recall(2000)
      if (mem) output.context.push("Conserver ces corrections/regles utilisateur:\n" + mem)
    },
  }
}
