> **Superseded on 2026-07-27:** The approved fresh-install direction includes private phpMyAdmin and two installers. See [Fresh POS Server and Spooler Installers](./2026-07-27-fresh-pos-server-and-spooler-installers.md). This file is historical and must not guide implementation.

# Deferred POS Server Installer and Database Screen

**Status:** Deferred  
**Decision date:** 2026-07-26

## Problem

Installing XAMPP and using phpMyAdmin on restaurant machines creates unnecessary setup and support work. The POS still needs a local relational database, but clients should not have to understand or operate the database stack.

## Decisions

1. Future restaurant installations will not require XAMPP, Apache, PHP, or phpMyAdmin.
2. MariaDB remains the local database engine and runs invisibly as a Windows service on the restaurant's main server only.
3. The application keeps `mysql2`; this decision does not authorize a Prisma ORM or Prisma Migrate conversion.
4. Prisma Studio will be the optional clean database screen for technicians and authorized support staff.
5. Prisma Studio will connect directly to MariaDB without becoming part of the POS runtime data layer.
6. Ordinary cashier and waiter terminals only open the POS through the main server's LAN address. They do not install MariaDB, Prisma, Node.js, or XAMPP.
7. Printer terminals install only the POS spooler when required.

## Target installation

The eventual deliverable is one offline-capable `POSAPP-Server-Setup.exe` that:

- silently installs a pinned, tested MariaDB LTS release as a Windows service;
- bundles the production application, Node runtime, and required dependencies;
- creates the database and a restricted application user with a generated password;
- binds the database to localhost and exposes only the POS HTTP port on the private LAN;
- installs the POS service with a dependency on the database service;
- imports an authoritative clean baseline schema and applies only explicitly ordered migrations;
- configures automatic backups and provides controlled restore tooling;
- creates POS and database-support shortcuts;
- verifies database connectivity, schema authority, application health, service restart, and reboot startup.

## Prisma Studio boundary

Prisma Studio is a support screen, not a cashier-facing administration feature.

- It is bundled locally so installation does not require npm or internet access.
- It starts only on demand and remains accessible from the server machine only.
- The normal shortcut should use a read-only database account.
- Direct write access, if ever provided, must be an explicit maintenance mode because Studio bypasses POS validation, permissions, audit events, and financial workflows.
- It is suitable for inspecting and filtering records, but it does not own backups, restores, database users, server configuration, or schema migrations.

## Required project work when resumed

- Create and verify a canonical empty-database bootstrap schema.
- Create an authoritative migration manifest; do not execute every file in `backend/migrations` alphabetically.
- Replace XAMPP assumptions in `service/README.md` and service installation scripts.
- Replace the hard-coded `C:\xampp\mysql\bin\mysqldump.exe` fallback in `scripts/db-backup.js`.
- Package MariaDB, Node, the built application, production dependencies, Prisma Studio, and service tooling.
- Generate and protect credentials without placing database passwords in desktop shortcut arguments.
- Preserve the database, configuration, and backups during upgrades and uninstallations.
- Add installation rollback and actionable logs.
- Test on a clean supported Windows installation, including an offline installation and a full reboot.
- Test the selected MariaDB LTS version against checkout, tables, split checks, refunds, subscriptions, JoFotara, reports, migrations, backups, and printing before deployment.

## Explicitly deferred

No installer, dependency, database migration, service change, Prisma package, or runtime behavior is implemented by this document. Resume this work only as a dedicated deployment project with clean-machine verification.
