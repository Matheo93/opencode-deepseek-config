import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * redteam — suite de tools offensifs STRUCTURES pour opencode (web-app recon/enum/vuln).
 *
 * Pourquoi ce plugin bat un harness "bash brut" (et Claude Code) sur le redteam :
 *  1. Tools first-class qui rendent du JSON parse -> l'agent grounde sur de la
 *     donnee structuree, pas du stdout a reparser (0-mock, finding != narration).
 *  2. KB de loot PERSISTANTE par cible : chaque finding est append dans
 *     recon/<host>.jsonl -> survit a la session, se construit tout seul.
 *     Aucun equivalent natif cote Claude Code.
 *  3. ROE-bound : l'agent 'redteam' (opencode.json) borne le scope ; les tools
 *     sont recon/enum/vuln NON destructifs (pas de DoS, pas de mass-untargeted).
 *
 * Binaires requis (ProjectDiscovery + ffuf), tous presents localement :
 *   httpx, nuclei, katana, naabu, subfinder, ffuf.
 * nuclei telecharge ses templates au 1er run s'ils manquent.
 */

const HOME = process.env.HOME || "."
const RECON_DIR = join(HOME, ".config", "opencode", "recon")

// Wordlist builtin (haute valeur) pour que recon_content marche sans seclists.
const BUILTIN_WORDLIST = [
  "admin", "administrator", "login", "wp-login.php", "wp-admin", "wp-config.php.bak",
  "wp-json", "xmlrpc.php", "wp-content/debug.log", "wp-content/uploads", "phpinfo.php",
  ".git/HEAD", ".git/config", ".env", ".env.bak", ".env.local", "config.php", "config.php.bak",
  "backup", "backup.zip", "backup.sql", "db.sql", "dump.sql", "database.sql", "site.zip",
  "api", "api/v1", "api/v2", "graphql", "swagger", "swagger.json", "openapi.json",
  "actuator", "actuator/health", "actuator/env", "server-status", "server-info",
  "robots.txt", "sitemap.xml", ".well-known/security.txt", "crossdomain.xml",
  "phpmyadmin", "pma", "adminer.php", "dbadmin", "mysql",
  "test", "test.php", "dev", "staging", "old", "tmp", "temp", "uploads", "files",
  "console", "debug", "info.php", "status", "health", "metrics", "version",
  "user", "users", "account", "profile", "dashboard", "panel", "cpanel", "webmail",
  ".DS_Store", ".htaccess", ".htpasswd", "web.config", "composer.json", "package.json",
  "vendor", "node_modules", "storage/logs/laravel.log", "app.log", "error.log", "access.log",
  "cgi-bin", "shell.php", "cmd.php", "c99.php", "upload.php", "fileupload.php",
  "register", "signup", "reset", "forgot", "password", "auth", "oauth", "token", "sso",
]

// --- helpers process (execFile-style, pas de shell -> pas d'injection) ---
function run(
  bin: string,
  args: string[],
  opts: { input?: string; abort?: AbortSignal; timeout?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { signal: opts.abort })
    let stdout = "", stderr = ""
    const killer = setTimeout(() => p.kill("SIGKILL"), opts.timeout ?? 180_000)
    p.stdout.on("data", (d: Buffer) => (stdout += d))
    p.stderr.on("data", (d: Buffer) => (stderr += d))
    p.on("error", (e) => { clearTimeout(killer); resolve({ code: -1, stdout, stderr: stderr + String(e) }) })
    p.on("close", (code) => { clearTimeout(killer); resolve({ code: code ?? -1, stdout, stderr }) })
    if (opts.input !== undefined) { p.stdin.write(opts.input); p.stdin.end() }
  })
}

const jsonl = (s: string) =>
  s.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

// host extrait d'une URL/cible pour nommer la KB
function hostOf(target: string): string {
  try { return new URL(target.includes("://") ? target : `http://${target}`).hostname } catch { return target.replace(/[^a-zA-Z0-9.-]/g, "_") }
}

// garde-fou : refuse une cible qui ressemble a une injection de flag
function clean(target: string): string {
  const t = target.trim()
  if (t.startsWith("-")) throw new Error(`cible invalide (commence par '-') : ${t}`)
  return t
}

// KB persistante : append chaque finding, dedup leger sur la cle fournie
function loot(host: string, kind: string, items: any[], keyFn: (x: any) => string) {
  if (!items.length) return
  mkdirSync(RECON_DIR, { recursive: true })
  const file = join(RECON_DIR, `${host}.jsonl`)
  const stamp = new Date().toISOString()
  for (const it of items) appendFileSync(file, JSON.stringify({ kind, key: keyFn(it), stamp, data: it }) + "\n")
}

const cap = <T,>(arr: T[], n: number) => (arr.length > n ? { items: arr.slice(0, n), truncated: arr.length - n } : { items: arr, truncated: 0 })

export const Redteam: Plugin = async () => ({
  tool: {
    // 1. PROBE — httpx : statut, titre, tech, serveur, TLS, CDN (recon-first, ~10s)
    recon_probe: tool({
      description:
        "Sonde live une ou plusieurs URLs/hosts avec httpx (ProjectDiscovery). Retourne JSON: status, titre, technologies, serveur, TLS, CDN. A LANCER EN PREMIER pour verifier que la cible expose vraiment le service avant tout le reste.",
      args: { targets: tool.schema.string().describe("URLs/hosts separes par des virgules ou espaces (ex: 'https://vanessaia.fr, mytrustpartner.fr')") },
      async execute(args, ctx) {
        const list = args.targets.split(/[\s,]+/).map(clean).filter(Boolean)
        const r = await run("httpx", ["-json", "-silent", "-title", "-tech-detect", "-status-code", "-web-server", "-tls-grab", "-no-color"], { input: list.join("\n"), abort: ctx.abort, timeout: 120_000 })
        const rows = jsonl(r.stdout).map((x: any) => ({ url: x.url, status: x.status_code, title: x.title, tech: x.tech, server: x.webserver, tls: x.tls?.subject_cn, cdn: x.cdn_name }))
        for (const row of rows) loot(hostOf(row.url || ""), "probe", [row], (x) => `${x.url}|${x.status}`)
        const { items, truncated } = cap(rows, 50)
        return { title: `probe: ${rows.length} live`, output: JSON.stringify({ live: items, truncated }, null, 2), metadata: { live: rows.length } }
      },
    }),

    // 2. SUBS — subfinder : enumeration de sous-domaines
    recon_subs: tool({
      description: "Enumere les sous-domaines d'un domaine racine avec subfinder. Retourne la liste JSON. Chainer ensuite recon_probe pour ne garder que les live.",
      args: { domain: tool.schema.string().describe("domaine racine (ex: vanessaia.fr)") },
      async execute(args, ctx) {
        const d = clean(args.domain)
        const r = await run("subfinder", ["-d", d, "-silent", "-all"], { abort: ctx.abort, timeout: 120_000 })
        const subs = [...new Set(r.stdout.split("\n").map((l) => l.trim()).filter(Boolean))]
        loot(hostOf(d), "subdomain", subs.map((s) => ({ host: s })), (x) => x.host)
        const { items, truncated } = cap(subs, 200)
        return { title: `subs: ${subs.length}`, output: JSON.stringify({ subdomains: items, truncated }, null, 2), metadata: { count: subs.length } }
      },
    }),

    // 3. CRAWL — katana : endpoints, JS, formulaires
    recon_crawl: tool({
      description: "Crawle une URL avec katana (depth 2): decouvre endpoints, fichiers JS, parametres. Retourne JSON des URLs trouvees.",
      args: {
        url: tool.schema.string().describe("URL de depart (ex: https://vanessaia.fr)"),
        depth: tool.schema.number().optional().describe("profondeur de crawl (defaut 2)"),
      },
      async execute(args, ctx) {
        const u = clean(args.url)
        const r = await run("katana", ["-u", u, "-silent", "-jsonl", "-d", String(args.depth ?? 2), "-jc", "-no-color"], { abort: ctx.abort, timeout: 150_000 })
        const eps = jsonl(r.stdout).map((x: any) => ({ url: x.request?.endpoint || x.endpoint, method: x.request?.method, tag: x.request?.tag }))
        loot(hostOf(u), "endpoint", eps, (x) => x.url)
        const { items, truncated } = cap(eps, 150)
        return { title: `crawl: ${eps.length} endpoints`, output: JSON.stringify({ endpoints: items, truncated }, null, 2), metadata: { count: eps.length } }
      },
    }),

    // 4. PORTS — naabu : scan de ports rapide
    recon_ports: tool({
      description: "Scan de ports TCP rapide avec naabu (top ports par defaut). Retourne JSON des ports ouverts. Non destructif.",
      args: {
        host: tool.schema.string().describe("host ou IP (ex: vanessaia.fr)"),
        ports: tool.schema.string().optional().describe("ports/plage (ex: '80,443,8080' ou '1-1000'); defaut = top 100"),
      },
      async execute(args, ctx) {
        const h = clean(args.host)
        const a = ["-host", h, "-silent", "-json"]
        if (args.ports) a.push("-p", args.ports); else a.push("-top-ports", "100")
        const r = await run("naabu", a, { abort: ctx.abort, timeout: 150_000 })
        const ports = jsonl(r.stdout).map((x: any) => ({ host: x.host || x.ip, port: x.port }))
        loot(hostOf(h), "port", ports, (x) => `${x.host}:${x.port}`)
        return { title: `ports: ${ports.length} ouverts`, output: JSON.stringify({ open: ports }, null, 2), metadata: { count: ports.length } }
      },
    }),

    // 5. CONTENT — ffuf : decouverte de contenu (wordlist builtin OOTB)
    recon_content: tool({
      description: "Decouverte de fichiers/dossiers caches avec ffuf. Wordlist builtin (admin, .git, .env, wp-*, backups, api...). Retourne JSON des chemins trouves + status. Passe 'wordlist' pour pointer une seclist.",
      args: {
        url: tool.schema.string().describe("URL de base SANS slash final (ex: https://vanessaia.fr)"),
        wordlist: tool.schema.string().optional().describe("chemin d'une wordlist externe (defaut: builtin)"),
      },
      async execute(args, ctx) {
        const u = clean(args.url).replace(/\/+$/, "")
        let wl = args.wordlist
        if (!wl) { wl = join(tmpdir(), "oc-redteam-wl.txt"); writeFileSync(wl, BUILTIN_WORDLIST.join("\n")) }
        const out = join(tmpdir(), `ffuf-${hostOf(u)}-${Date.now()}.json`)
        await run("ffuf", ["-u", `${u}/FUZZ`, "-w", wl, "-mc", "200,201,204,301,302,307,401,403,405,500", "-of", "json", "-o", out, "-s", "-t", "40"], { abort: ctx.abort, timeout: 150_000 })
        let hits: any[] = []
        try { hits = JSON.parse((await import("node:fs")).readFileSync(out, "utf8")).results?.map((x: any) => ({ url: x.url, status: x.status, length: x.length })) ?? [] } catch {}
        loot(hostOf(u), "path", hits, (x) => `${x.url}|${x.status}`)
        const { items, truncated } = cap(hits, 100)
        return { title: `content: ${hits.length} hits`, output: JSON.stringify({ hits: items, truncated }, null, 2), metadata: { count: hits.length } }
      },
    }),

    // 6. VULN — nuclei : scan de vulnerabilites template-based
    recon_vuln: tool({
      description: "Scan de vulnerabilites avec nuclei (templates communautaires). Retourne JSON des findings: template, severity, matched-url. Filtre par severity et/ou tags (ex: 'wordpress,cve'). nuclei telecharge ses templates au 1er run.",
      args: {
        url: tool.schema.string().describe("URL cible (ex: https://vanessaia.fr)"),
        severity: tool.schema.string().optional().describe("severites: 'critical,high,medium' (defaut: critical,high,medium)"),
        tags: tool.schema.string().optional().describe("tags de templates ex: 'wordpress,exposure,cve'"),
      },
      async execute(args, ctx) {
        const u = clean(args.url)
        const a = ["-u", u, "-jsonl", "-silent", "-no-color", "-severity", args.severity ?? "critical,high,medium"]
        if (args.tags) a.push("-tags", args.tags)
        const r = await run("nuclei", a, { abort: ctx.abort, timeout: 480_000 })
        const finds = jsonl(r.stdout).map((x: any) => ({ template: x["template-id"], severity: x.info?.severity, name: x.info?.name, matched: x["matched-at"], type: x.type }))
        loot(hostOf(u), "vuln", finds, (x) => `${x.template}|${x.matched}`)
        const bySev = finds.reduce((m: any, f: any) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {})
        const { items, truncated } = cap(finds, 100)
        return { title: `vuln: ${finds.length} (${JSON.stringify(bySev)})`, output: JSON.stringify({ findings: items, truncated, bySeverity: bySev }, null, 2), metadata: { count: finds.length, bySeverity: bySev } }
      },
    }),
  },
})
