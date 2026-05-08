# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial public documentation baseline.
- Marketplace metadata and community templates.

## [0.0.1] - 2026-02-08

### Added
- VS Code extension foundation for RunQL.
- SQL execution with results panel and CSV export hooks.
- Connection management and schema introspection for DuckDB, PostgreSQL, and MySQL.
- Workspace-local DuckDB Data Work database and local caching flows.
- Custom RunQL notebooks (`*.dpnb`) for analyze/transform workflows.
- Pipeline lineage tracking and lineage visualization.
- ERD generation and artifact persistence.
- Optional AI-assisted docs/comments with provider flexibility.

## [1.2] - 2026-03-10

### Added
- Fix for a bug that caused the initialization screen to not show up.
- Update to add AGENTS.md to the project root.

## [1.2.1] - 2026-03-11

### Added
- Fix for links on welcome page.

## [1.2.3] - 2026-03-11

### Added
- Fix for test links

## [1.3.0] - 2026-03-26

### Added
- Added the ability to reuse existing connection details when adding a new connection.

## [1.4.0] - 2026-04-03

### Added
- Welcome page improvements
- Added better support in the UI actions for non-copilot AI extensions (Claude Code, Codex extensions)
- Added a new Markdown section that is tied to the SQL query.
- Changes for SecureQL connections.

## [1.4.1] - 2026-04-03

### Added
- Added settings to select Claude Code or Codex extensions for the AI provider.
- You can now use Copilot, Claude Code extension, or Codex extension.
- When using the Codex extension, the files are added as context and the prompt is automatically copied to your clipboard so you can paste it into chat.

## [1.5.0] - 2026-04-15

### Added
Redesign AI settings, add What's New guidance, and normalize AI settings across user/workspace scopes

- replace internal AI terminology with clearer user-facing settings: AI Source, AI Extension, API Provider, AI Model, and API Base URL
- set new defaults to GitHub Copilot / VS Code AI, Automatic extension, and gpt-4.1
- remove deprecated AI settings from the settings manifest
- add a What's New page for upgrades and expose a command to reopen it
- add an AI Settings Guide to the welcome page for new installs
- reset AI settings to the new defaults for this release in both user and workspace scopes
- keep user and workspace AI settings synchronized after config changes
- clear removed legacy AI keys to avoid stale workspace overrides
- update README and docs to reflect the new AI setup model

## [1.5.1] - 2026-04-15

### Added
- Redeploy for the full IDE build process.


## [1.5.2] - 2026-04-15

### Added
- Remove duckdb from the core client and prep to release duckdb support as its own extension adapter.

## [1.6.0] - 2026-04-16

### Added
1. Use effective SQL dialect for SecureQL AI prompts and query metadata
- Centralize AI connection dialect resolution on resolveEffectiveSqlDialect() so SecureQL-backed prompts receive the underlying database dialect rather than the connector name.
- Update query markdown/frontmatter and per-document query index context to persist the effective SQL dialect consistently, while leaving adapter routing on the raw connector dialect.

2. Move ERD artifacts into per-connection schema bundles and stop using RunQL/system/erd at runtime.

Add a one-time startup migration that:
- migrates legacy flat schema files into bundle folders
- moves legacy files into RunQL/system/migration_backup
- records migration state and manifest
- removes the empty legacy system/erd directory
- normalizes bundle layout sidecars to erd.layout.json

Also update watchers, docs, and tests for the new storage layout.

## [1.7.0] - 2026-05-07

### Added
1. Added support to connect to admin schemas and views for a dbms (db admin).
- This will return all admin schemas/views in one connection (e.g. information_schema, performance_schema, etc.)
- When creating a connection you now choose between two types: data access or db admin.
- This is supported for all connections including SecureQL.

## [1.7.1] - 2026-05-08

### Fix
Fixed missing image icons.