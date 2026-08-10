#!/bin/bash
# Install MediaWiki and seed customer documentation pages.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source ./.env; set +a

dc() { docker compose "$@"; }

echo "waiting for wiki db"
until dc exec -T wiki-db mariadb -uwiki -p"${POSTGRES_PASSWORD}" wiki -e "select 1" >/dev/null 2>&1; do sleep 3; done

if ! dc exec -T mediawiki test -f /var/www/html/LocalSettings.php; then
  dc exec -T mediawiki php maintenance/run.php install \
    --dbtype mysql --dbserver wiki-db --dbname wiki \
    --dbuser wiki --dbpass "${POSTGRES_PASSWORD}" \
    --server "https://wiki.${DOMAIN}" --scriptpath "" \
    --pass "${WIKI_ADMIN_PASSWORD}" "Ops Wiki" admin
fi

for f in wiki/pages/*.wiki; do
  title=$(basename "$f" .wiki | tr '_' ' ')
  sed "s/__DOMAIN__/${DOMAIN}/g" "$f" | \
    dc exec -T mediawiki php maintenance/run.php edit --user admin --summary seed "$title"
done
echo "wiki configured"
