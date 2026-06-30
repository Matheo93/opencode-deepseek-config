# opencode-deepseek-config

Config [opencode](https://opencode.ai) tunée pour **DeepSeek V4** (Pro / Flash), avec
3 agents prêts à l'emploi et un plugin de **mémoire longue cross-model**.

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
