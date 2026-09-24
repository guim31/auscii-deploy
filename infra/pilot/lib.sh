# auscii-deploy — fonctions communes à install.sh, update.sh et restore.sh.
# Fichier sourcé (bash), jamais exécuté seul.
# shellcheck shell=bash

# Lit une variable du fichier .env (dernière occurrence), sans l'exécuter.
# Accepte NOM=valeur, NOM='valeur' (avec \' pour une apostrophe) et NOM="valeur".
env_get() {
	local key="$1" file="${2:-.env}" line value
	line=$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1) || true
	value="${line#*=}"
	if [[ "$value" == \'*\' && ${#value} -ge 2 ]]; then
		value="${value:1:${#value}-2}"
		value="${value//\\\'/\'}"
	elif [[ "$value" == \"*\" && ${#value} -ge 2 ]]; then
		value="${value:1:${#value}-2}"
	fi
	printf '%s' "$value"
}

# Écrit NOM='valeur' dans .env (remplace la ligne existante ou l'ajoute), de
# façon atomique. Les valeurs passent par l'environnement d'awk : aucun
# caractère (&, |, /, $) n'est interprété. Entre apostrophes, Compose prend la
# valeur telle quelle, sans remplacer les $ ; seule \' y est une séquence.
env_set() {
	local key="$1" value="$2" file="${3:-.env}" tmp
	[[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || {
		echo "Nom de variable invalide : $key" >&2
		return 1
	}
	if [[ "$value" == *$'\n'* || "$value" == *\\* ]]; then
		echo "Valeur refusée pour $key : retour à la ligne ou barre oblique inverse." >&2
		return 1
	fi
	value="${value//\'/\\\'}"
	tmp=$(mktemp "${file}.XXXXXX")
	touch "$file"
	ENV_KEY="$key" ENV_LINE="$key='$value'" awk '
		BEGIN { key = ENVIRON["ENV_KEY"]; line = ENVIRON["ENV_LINE"]; done = 0 }
		index($0, key "=") == 1 { if (!done) { print line; done = 1 } ; next }
		{ print }
		END { if (!done) print line }
	' "$file" >"$tmp"
	chmod 600 "$tmp"
	mv -f "$tmp" "$file"
}

# Tag d'image acceptable : SHA court publié par la CI (ou autre étiquette
# explicite), jamais "latest".
valid_tag() {
	[[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] && [[ "$1" != "latest" ]]
}

# Attend que le conteneur de l'application soit « healthy » (3 min maximum).
wait_app_healthy() {
	local status id
	for _ in $(seq 1 90); do
		id=$(docker compose ps -q app 2>/dev/null || true)
		if [ -n "$id" ]; then
			status=$(docker inspect --format '{{.State.Health.Status}}' "$id" 2>/dev/null || echo starting)
			[ "$status" = "healthy" ] && return 0
		fi
		sleep 2
	done
	return 1
}

# Le worker n'a pas de sonde de santé : on vérifie qu'il tourne toujours, sans
# redémarrage, 15 s après le démarrage de l'application.
worker_running() {
	local id state
	sleep 15
	id=$(docker compose ps -q worker 2>/dev/null || true)
	[ -n "$id" ] || return 1
	state=$(docker inspect --format '{{.State.Running}} {{.RestartCount}}' "$id" 2>/dev/null || true)
	[ "$state" = "true 0" ]
}

confirm() {
	# $1 = question ; renvoie 0 si la réponse est « o » ou « oui ».
	local answer
	if [ "${ASSUME_YES:-0}" = 1 ]; then
		echo "$1 [o/N] o (--yes)"
		return 0
	fi
	if [ ! -t 0 ]; then
		echo "$1 [o/N] n (pas de terminal)"
		return 1
	fi
	read -rp "$1 [o/N] " answer
	[[ "$answer" =~ ^([oO]|[oO][uU][iI])$ ]]
}
