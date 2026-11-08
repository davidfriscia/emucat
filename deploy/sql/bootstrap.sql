-- Creates the EmuCat database and its application account on the host's existing MariaDB server.
-- Run once per server, as a MariaDB administrator, for example:
--
--   sudo mariadb < deploy/sql/bootstrap.sql            (after replacing the password below)
--
-- It touches nothing but `emucat-db` and 'emucat-usr'@'%'. It never drops anything, so running it again
-- on a server that already has the database is harmless. Tables are created by the migrations that
-- `emucatctl update` applies, never here.
--
-- The names contain hyphens, so they are always quoted: backticks for the database, single quotes for
-- the account. Replace CHANGE_ME with the DB_PASSWORD from /etc/emucat/app.env (32+ random characters).

CREATE DATABASE IF NOT EXISTS `emucat-db`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_uca1400_ai_ci;

-- '%' lets the API container connect from its Docker network. Reachability is limited by the server's
-- bind-address and the firewall (see docs/deployment.md), not by this host pattern.
CREATE USER IF NOT EXISTS 'emucat-usr'@'%' IDENTIFIED BY 'CHANGE_ME';

-- Everything inside its own database, nothing outside it. Migrations need DDL; backups need
-- SHOW VIEW, TRIGGER, EVENT and LOCK TABLES, all included here.
GRANT ALL PRIVILEGES ON `emucat-db`.* TO 'emucat-usr'@'%';

-- Not ALL ON *.*, no GRANT OPTION, no SUPER, no FILE: the application account cannot reach other
-- databases or the server's files.
