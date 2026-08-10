#!/bin/bash
# Runs inside the mariadb entrypoint on first init. DB_PASSWORD comes from the
# container environment.
mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS icingadb;
CREATE USER IF NOT EXISTS 'icingadb'@'%' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL ON icingadb.* TO 'icingadb'@'%';

CREATE DATABASE IF NOT EXISTS icingaweb;
CREATE USER IF NOT EXISTS 'icingaweb'@'%' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL ON icingaweb.* TO 'icingaweb'@'%';

FLUSH PRIVILEGES;
SQL
