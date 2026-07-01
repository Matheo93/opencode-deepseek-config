# opencode-deepseek-config

Config [opencode](https://opencode.ai) tunée pour **DeepSeek V4** (Pro / Flash), avec
**4 agents** prêts à l'emploi, un plugin de **mémoire longue cross-model**, et une
**suite red-team web** (recon/enum/vuln structurée + loot KB persistant).

À déposer dans `~/.config/opencode/`.

## Install

```bash
# 1. cloner dans le dossier de config opencode
git clone <repo-url> ~/.config/opencode
cd ~/.config/opencode

# 2. installer la dépendance du plugin (longmem)
bun install      # crée node_modules + bun.lock (gitignorés)

# 3. fournir SA clé DeepSeek (jamais commitée — lue depuis l'env)
export DEEPSEEK_API_KEY="sk-..."   # à mettre dans ~/.zshrc / ~/.bashrc

# 4. lancer
opencode
```

> La clé n'est **pas** dans le repo : `opencode.json` la lit via `{env:DEEPSEEK_API_KEY}`.
> Chacun met la sienne dans son env.

## Le tuning DeepSeek — le point à NE PAS défaire

`deepseek-v4-pro` est un **reasoner** : laissé par défaut, il crame tout son
`max_tokens` en *thinking* avant de répondre. Le réglage clé est donc par agent,
dans `options` :

| agent  | mode     | modèle            | options                          | usage |
|--------|----------|-------------------|----------------------------------|-------|
| `ops`  | primary  | v4-pro            | `thinking: { type: "disabled" }` | opérateur DevOps/SRE autonome, déploie via ssh, mesure, corrige en boucle |
| `deep` | subagent | v4-pro            | `reasoning_effort: "high"`       | problèmes durs : debug retors, optim perf, analyse système |
| `fast` | subagent | v4-flash          | `thinking: { type: "disabled" }` | volume : lecture logs, grep, petites edits |

Règle : **thinking disabled** partout sauf quand on veut explicitement raisonner
(`deep`, en `reasoning_effort: high`). Sinon le pro brûle ses tokens en pensée
et tronque la réponse.

`small_model` = `deepseek-v4-flash` (résumés, titres, tâches secondaires).

## Plugin `plugin/longmem.ts` — mémoire longue + auto-critique

opencode repart sans mémoire, et même intra-session une correction se noie 3
messages plus loin (compaction). Le plugin résout ça avec ses hooks :

- **capture** des corrections user → `memory/LESSONS.md`
  - explicite : message préfixé `#mem ` / `#regle ` / `#lesson ` (priorité haute)
  - implicite : marqueur de correction/frustration détecté → leçon candidate
- **réinjection** des leçons dans le system prompt **à chaque tour**
  (`experimental.chat.system.transform`)
- **survie à la compaction** (`experimental.session.compacting`)
- **auto-critique cross-model** : à la fin d'un tour, `flash` juge l'échange
  (fresh context, zéro loyauté au générateur `pro`) et extrait une `LESSON:`
  dense — correction à ne pas refaire, ou fait d'infra réutilisable.

`memory/LESSONS.md` est **gitignoré** (perso, propre à chaque opérateur). Il se
crée tout seul au premier lancement.

## Suite red-team — `plugin/redteam.ts` + agent `redteam`

Ce qui fait d'opencode un meilleur harness offensif qu'un CLI généraliste : des
**tools first-class qui rendent du JSON** (l'agent grounde sur de la donnée
structurée, pas du stdout à reparser) + une **KB de loot persistante par cible**
qui se construit toute seule et survit aux sessions.

> ⚠️ **Scope.** Outils recon / énumération / scan de vulns **non destructifs**
> (pas de DoS, pas de ciblage de masse). À n'utiliser que sur des cibles que tu
> es **autorisé** à tester (ROE / pentest engagement / lab). L'agent `redteam`
> est cadré pour refuser hors-scope.

### 6 tools structurés (lancé via l'agent `redteam`)

| tool | binaire | rôle |
|------|---------|------|
| `recon_probe`   | httpx     | sonde live : status, titre, tech, serveur, TLS, CDN (**recon-first**) |
| `recon_subs`    | subfinder | énumération de sous-domaines |
| `recon_crawl`   | katana    | crawl endpoints / JS / params |
| `recon_ports`   | naabu     | scan de ports TCP rapide |
| `recon_content` | ffuf      | fichiers/dossiers cachés (`.git`, `.env`, `wp-*`, backups, api…) — **wordlist builtin**, marche sans seclists |
| `recon_vuln`    | nuclei    | scan de vulns template-based, filtrable par `severity`/`tags` |

Chaque tool **append ses findings** dans `recon/<host>.jsonl` (gitignoré, perso) :
une mémoire de cible persistante (ports, endpoints, vulns, paths) qu'aucun CLI
généraliste n'offre nativement.

### Prérequis binaires

Stack [ProjectDiscovery](https://github.com/projectdiscovery) + ffuf :
```bash
# via go install (ou les releases github)
go install github.com/projectdiscovery/httpx/cmd/httpx@latest
go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest
go install github.com/projectdiscovery/katana/cmd/katana@latest
go install github.com/projectdiscovery/naabu/v2/cmd/naabu@latest
go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest
go install github.com/ffuf/ffuf/v2@latest
# nuclei télécharge ses templates au 1er run
```

### Usage

```bash
opencode --agent redteam            # bascule sur l'opérateur offensif
# puis : "recon vanessaia.fr, scope ROE signé"
# -> l'agent enchaîne probe -> subs -> crawl/content -> vuln, loot auto, rapport structuré
```

L'agent escalade l'exploitation ciblée à la main (sqlmap, curl) via `bash` quand
un lead est solide. Méthodo : recon-first, 0-mock (chaque claim groundé sur la
sortie d'un tool), pas de validation demandée, boucle jusqu'au résultat vérifié.

## Navigateur réel + OCR — `plugin/browser.ts` + `plugin/vision.ts`

Deux manques quand le modèle n'a pas de vision et qu'on n'a pas les droits root :
il **lit mal les images collées** et il n'a **pas de navigateur**. Corrigés,
**sans sudo** — Chrome for Testing s'installe dans le home, pas besoin de root.

### Navigateur (`browser_*`, Chrome headless via puppeteer-core)
Conçu **text-first** : les tools ne rendent pas des pixels (illisibles pour un
modèle texte) mais un **snapshot texte** = texte visible + éléments interactifs
numérotés `[ref]`. On clique/remplit par `[ref]`. Même principe que Playwright MCP.

| tool | rôle |
|------|------|
| `browser_open(url)`        | ouvre + snapshot (titre, texte, éléments `[ref]`) |
| `browser_read()`           | re-snapshot la page courante |
| `browser_click(ref)`       | clique par `[ref]`, selector CSS, ou `text=…` |
| `browser_type(ref,text,submit?)` | remplit un champ, Enter optionnel |
| `browser_extract(selector,attr?)` | récolte texte/href/attr par CSS (pas d'eval JS) |
| `browser_screenshot(full?)` | PNG (archive / pour un modèle vision) |

Le navigateur **persiste entre les tool calls** d'une session (singleton).

### OCR (`image_read`, tesseract.js WASM)
`image_read(src)` — OCR fra+eng d'une image (chemin, `data:`, `file://`, http).
Quand une image est collée, l'agent passe son `url` → texte extrait. Limite
honnête : OCR de **texte** dans l'image, pas de compréhension de photo/scène.

### Prérequis (no-sudo)
```bash
bun install            # installe puppeteer-core + tesseract.js (pur JS/WASM)
# Chrome n'est PAS téléchargé par puppeteer-core -> une fois, sans root :
npx @puppeteer/browsers install chrome@stable   # -> ~/.cache/puppeteer/chrome/
# tesseract télécharge ses données de langue en cache au 1er OCR.
```
`browser.ts` prend le Chrome le plus récent de `~/.cache/puppeteer/chrome/`, ou
`PUPPETEER_EXECUTABLE_PATH` si tu pointes un autre binaire. Aucun `apt`, aucun sudo.

## Recherche de posts X — `plugin/x.ts` (`x_search`)

Deux façons de chercher sur X avec une clé xAI/Grok :
1. **ask LLM** — tu poses une question, Grok cherche X et te digère la réponse.
2. **je cherche moi-même** (`x_search`) — tu passes TA query, on récupère les
   **posts bruts + leurs liens** (`x.com/…/status/…`), puis tu ouvres les
   intéressants avec `browser_open` pour lire le contenu/l'outil.

`x_search(query, mode?, limit?, from_date?)` utilise l'**Agent Tools API** de xAI
(`POST /v1/responses`, `tools:[{type:"x_search"}]` → `x_keyword_search` /
`x_semantic_search`). ⚠️ l'ancien `search_parameters` (live search) est
**déprécié** côté xAI, ne pas l'utiliser.

Clé : lue depuis **`process.env.XAI_API_KEY`**, jamais en dur. Mets-la en env
(ex: `~/.config/xai.env` avec `export XAI_API_KEY=xai-…`, sourcé au démarrage),
comme la clé DeepSeek.

## AGENTS.md

Disposition globale injectée dans tous les agents : opérateur autonome, 0-mock
(chaque claim groundé sur une mesure live), boucle modif→test via ssh, load-test
à l'instrumentation. À adapter à ton workflow.

## Arbo

```
opencode.json        # modèles, provider DeepSeek, permissions, 3 agents
AGENTS.md            # disposition opérateur (instructions globales)
plugin/longmem.ts    # mémoire longue + auto-critique cross-model
package.json         # dépendance @opencode-ai/plugin
.gitignore           # exclut node_modules, memory/ (perso), *.bak
```
