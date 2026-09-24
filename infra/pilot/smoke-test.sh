#!/usr/bin/env bash
# auscii-deploy — test de fumée de la pile du pilote, lancé par la CI (job
# « images ») sur les images qui viennent d'être construites, et utilisable à
# la main sur une machine de test :
#
#   GHCR_OWNER=auscii IMAGE_TAG=3f8a1c2 bash infra/pilot/smoke-test.sh
#
# Démarre la pile sans Caddy (il lui faudrait un DNS public) avec un .env
# jetable, puis vérifie : Caddyfile valide, migrations, /api/health, en-têtes
# de sécurité, worker, création du compte admin, /data inscriptible,
# sauvegarde, restauration (deux fois), et la santé après restauration.
# Refuse de tourner s'il existe déjà un .env (pile réelle) à côté.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=lib.sh
source ./lib.sh

: "${GHCR_OWNER:?GHCR_OWNER requis}"
: "${IMAGE_TAG:?IMAGE_TAG requis}"
if [ -e .env ]; then
	echo "Un .env existe déjà dans $(pwd) : test de fumée refusé (pile réelle ?)." >&2
	exit 1
fi

cleanup() {
	status=$?
	if [ "$status" -ne 0 ]; then
		echo "::group::docker compose ps / logs"
		docker compose ps -a || true
		docker compose logs --no-color --tail 80 || true
		echo "::endgroup::"
	fi
	if [ "${SMOKE_KEEP:-0}" != 1 ]; then
		docker compose --profile tools down -v --remove-orphans >/dev/null 2>&1 || true
		rm -f .env
	fi
	exit "$status"
}
trap cleanup EXIT

step() { echo "==> $*"; }
fail() {
	echo "ÉCHEC : $*" >&2
	exit 1
}

cp .env.example .env
chmod 600 .env
env_set PILOT_HOST "pilot.smoke.invalid"
env_set PREVIEW_APP_HOST "apercu.smoke-preview.invalid"
env_set ACME_EMAIL "smoke@example.com"
env_set GHCR_OWNER "$GHCR_OWNER"
env_set IMAGE_TAG "$IMAGE_TAG"
env_set POSTGRES_PASSWORD "$(openssl rand -hex 24)"
env_set BETTER_AUTH_SECRET "$(openssl rand -hex 32)"
env_set APP_ENCRYPTION_KEY "$(openssl rand -hex 32)"
unset GHCR_OWNER IMAGE_TAG

step "docker compose config"
docker compose config -q

step "Caddyfile"
docker compose run --rm --no-deps -T --entrypoint caddy caddy \
	validate --config /etc/caddy/Caddyfile --adapter caddyfile

step "Démarrage sans Caddy (db, migrate, app, worker, backup)"
docker compose up -d --pull never db migrate app worker backup
[ "$(docker inspect --format '{{.State.ExitCode}}' "$(docker compose ps -aq migrate)")" = 0 ] ||
	fail "migrations"

step "Santé de l'application"
wait_app_healthy || fail "l'application n'est pas healthy"
app_fetch() {
	# $1 = chemin ; affiche le code HTTP puis les en-têtes utiles, et le corps
	docker compose exec -T app node -e '
		fetch("http://127.0.0.1:3000" + process.argv[1], { redirect: "manual" }).then(async (r) => {
			console.log(r.status);
			for (const h of ["content-security-policy", "x-frame-options"]) console.log(h + ": " + r.headers.get(h));
			console.log(await r.text());
		}).catch((e) => { console.error(e); process.exit(1); });
	' "$1"
}
health=$(app_fetch /api/health)
echo "$health"
[ "$(head -n 1 <<<"$health")" = 200 ] || fail "/api/health"
grep -q '"database":"ok"' <<<"$health" || fail "/api/health sans base"
login=$(app_fetch /login)
[ "$(head -n 1 <<<"$login")" = 200 ] || fail "/login"
grep -q "^content-security-policy: default-src 'self';.*frame-src 'self'" <<<"$login" || fail "CSP absente de /login"
grep -q "^x-frame-options: SAMEORIGIN" <<<"$login" || fail "X-Frame-Options absent de /login"

step "Worker"
worker_running || fail "le worker ne tourne pas"
for _ in $(seq 1 30); do
	docker compose logs worker 2>/dev/null | grep -q "prêt" && break
	sleep 2
done
docker compose logs worker | grep -q "prêt" || fail "le worker n'a pas démarré pg-boss"

step "Compte administrateur (seed ponctuel)"
if ADMIN_EMAIL=Admin@Smoke.test ADMIN_PASSWORD=short docker compose run --rm --no-deps -T \
	-e ADMIN_EMAIL -e ADMIN_PASSWORD migrate node --import tsx prisma/seed.ts; then
	fail "mot de passe trop court accepté"
fi
ADMIN_EMAIL=Admin@Smoke.test ADMIN_PASSWORD=smoke-admin-password docker compose run --rm --no-deps -T \
	-e ADMIN_EMAIL -e ADMIN_PASSWORD migrate node --import tsx prisma/seed.ts
ADMIN_EMAIL=admin@smoke.test ADMIN_PASSWORD=smoke-admin-password docker compose run --rm --no-deps -T \
	-e ADMIN_EMAIL -e ADMIN_PASSWORD migrate node --import tsx prisma/seed.ts | grep -q "déjà présent" ||
	fail "seed non idempotent"

psql_count() {
	docker compose exec -T db psql -U auscii -d auscii -Atc "$1"
}
[ "$(psql_count "select count(*) from \"user\" where email = 'admin@smoke.test'")" = 1 ] ||
	fail "compte admin absent"

step "/data inscriptible (uid 1001)"
for svc in app worker; do
	docker compose exec -T "$svc" node -e '
		const fs = require("node:fs");
		fs.mkdirSync("/data/releases/smoke", { recursive: true });
		fs.writeFileSync("/data/releases/smoke/" + process.argv[1], "ok");
	' "$svc" || fail "/data non inscriptible dans $svc"
done

step "Sauvegarde"
out=$(docker compose run --rm -T backup run)
echo "$out"
db_file=$(sed -n 's#^BACKUP_DB_FILE=/backups/daily/##p' <<<"$out")
[ -n "$db_file" ] || fail "nom du dump absent"
data_file="data-${db_file#db-}"
data_file="${data_file%.sql.gz}.tar.gz"
docker compose exec -T backup /usr/local/bin/backup.sh check

step "Restauration (base et fichiers)"
psql_count "delete from \"user\"" >/dev/null
docker compose exec -T app node -e 'require("node:fs").rmSync("/data/releases/smoke", { recursive: true })'
./restore.sh --yes "$db_file" "$data_file"
[ "$(psql_count "select count(*) from \"user\" where email = 'admin@smoke.test'")" = 1 ] ||
	fail "compte admin non restauré"
docker compose exec -T worker test -f /data/releases/smoke/worker || fail "fichiers non restaurés"
docker compose exec -T worker test -w /data/releases || fail "fichiers restaurés non inscriptibles"

step "Deuxième cycle sauvegarde / restauration"
out=$(docker compose run --rm -T backup run)
db_file=$(sed -n 's#^BACKUP_DB_FILE=/backups/daily/##p' <<<"$out")
./restore.sh --yes --no-restart "$db_file"
docker compose up -d --pull never db migrate app worker backup
wait_app_healthy || fail "l'application n'est pas healthy après la deuxième restauration"
worker_running || fail "le worker ne tourne pas après la deuxième restauration"

echo "Test de fumée réussi."
