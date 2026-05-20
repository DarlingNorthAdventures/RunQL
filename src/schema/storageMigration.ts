import * as vscode from 'vscode';
import { ensureDPDirs, fileExists, readJson, writeJson } from '../core/fsWorkspace';
import { Logger } from '../core/logger';
import { SchemaIntrospection } from '../core/types';
import {
  LEGACY_SCHEMA_BUNDLE_LAYOUT_FILE,
  buildSchemaBundlePaths,
  buildConnectionSchemaPaths,
  getMigrationBackupRoot,
  getMigrationBackupErdRoot,
  getMigrationBackupManifestUri,
  getMigrationBackupSchemasRoot,
  getSchemaMigrationsRoot,
  getSchemaBundleMigrationStateUri,
  getSchemasRoot,
  listSchemaBundleDirsInConnection,
  listSchemaConnectionDirs,
  resolveSchemaConnectionDir,
  resolveSchemaBundlePaths,
  sanitizeSchemaBundleName,
} from './schemaPaths';
import { saveSchema } from './schemaStore';
import { SchemaDescriptionsFile } from './descriptionStore';

interface MigrationState {
  version: '1';
  status: 'complete' | 'failed';
  attemptedAt: string;
  completedAt?: string;
  error?: string;
  migratedBundles: number;
  backupManifestPath: string;
}

interface MigrationManifestEntry {
  kind: 'schema' | 'description' | 'custom.relationships' | 'erd' | 'layout' | 'orphan';
  source: string;
  destination?: string;
  backup: string;
  status: 'migrated' | 'backed_up';
}

interface MigrationManifest {
  version: '1';
  startedAt: string;
  completedAt?: string;
  entries: MigrationManifestEntry[];
  warnings: string[];
}

interface LegacyBundleFiles {
  baseName: string;
  schema: vscode.Uri;
  description: vscode.Uri;
  customRelationships: vscode.Uri;
  erd: vscode.Uri;
  layout: vscode.Uri;
}

interface ConnectionLevelBundleFiles {
  connectionDir: vscode.Uri;
  schema: vscode.Uri;
  description: vscode.Uri;
  customRelationships: vscode.Uri;
  erd: vscode.Uri;
  layout: vscode.Uri;
}

function isDirectoryType(type: vscode.FileType | number): boolean {
  return type === 2 || (Boolean(vscode.FileType) && type === vscode.FileType.Directory);
}

async function removeLegacyErdDirIfEmpty(dpDir: vscode.Uri): Promise<void> {
  const legacyErdRoot = vscode.Uri.joinPath(dpDir, 'system', 'erd');
  try {
    const entries = await vscode.workspace.fs.readDirectory(legacyErdRoot);
    if (entries.length === 0) {
      await vscode.workspace.fs.delete(legacyErdRoot, { recursive: false, useTrash: false });
    }
  } catch {
    // Ignore missing directory or inability to inspect legacy folder.
  }
}

async function normalizeSchemaLevelLayoutFilenames(dpDir: vscode.Uri): Promise<void> {
  const connectionDirs = await listSchemaConnectionDirs(dpDir, true);
  for (const connectionDir of connectionDirs) {
    const bundleDirs = await listSchemaBundleDirsInConnection(connectionDir);
    for (const bundleDir of bundleDirs) {
      const legacyLayoutUri = vscode.Uri.joinPath(bundleDir, LEGACY_SCHEMA_BUNDLE_LAYOUT_FILE);
      const newLayoutUri = buildSchemaBundlePaths(bundleDir).layout;
      try {
        if (await fileExists(legacyLayoutUri) && !await fileExists(newLayoutUri)) {
          await vscode.workspace.fs.rename(legacyLayoutUri, newLayoutUri, { overwrite: false });
        }
      } catch (err) {
        Logger.warn(`Failed to normalize ERD layout filename in ${bundleDir.fsPath}`, err);
      }
    }
  }
}

function legacyBundleFiles(dpDir: vscode.Uri, baseName: string): LegacyBundleFiles {
  const schemasRoot = getSchemasRoot(dpDir);
  const legacyErdRoot = vscode.Uri.joinPath(dpDir, 'system', 'erd');
  return {
    baseName,
    schema: vscode.Uri.joinPath(schemasRoot, `${baseName}.json`),
    description: vscode.Uri.joinPath(schemasRoot, `${baseName}.description.json`),
    customRelationships: vscode.Uri.joinPath(schemasRoot, `${baseName}.custom.relationships.json`),
    erd: vscode.Uri.joinPath(legacyErdRoot, `${baseName}.erd.json`),
    layout: vscode.Uri.joinPath(legacyErdRoot, `${baseName}.layout.json`),
  };
}

async function listLegacySchemaBaseNames(dpDir: vscode.Uri): Promise<string[]> {
  const root = getSchemasRoot(dpDir);
  try {
    const entries = await vscode.workspace.fs.readDirectory(root);
    return entries
      .map(([name]) => name)
      .filter((name) =>
        name.endsWith('.json') &&
        !name.endsWith('.description.json') &&
        !name.endsWith('.custom.relationships.json')
      )
      .map((name) => name.replace(/\.json$/i, ''));
  } catch {
    return [];
  }
}

async function hasLegacySchemaStorage(dpDir: vscode.Uri): Promise<boolean> {
  const schemasRoot = getSchemasRoot(dpDir);
  try {
    const entries = await vscode.workspace.fs.readDirectory(schemasRoot);
    if (entries.some(([name]) => name.endsWith('.json'))) {
      return true;
    }
    for (const [name, type] of entries) {
      if (!isDirectoryType(type)) continue;
      if (await fileExists(vscode.Uri.joinPath(schemasRoot, name, 'schema.json'))) {
        return true;
      }
    }
  } catch {
    // Ignore absent schema directory.
  }

  const legacyErdRoot = vscode.Uri.joinPath(dpDir, 'system', 'erd');
  try {
    const entries = await vscode.workspace.fs.readDirectory(legacyErdRoot);
    return entries.some(([name]) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

async function listConnectionLevelLegacyBundles(dpDir: vscode.Uri): Promise<ConnectionLevelBundleFiles[]> {
  const schemasRoot = getSchemasRoot(dpDir);
  try {
    const entries = await vscode.workspace.fs.readDirectory(schemasRoot);
    const bundles: ConnectionLevelBundleFiles[] = [];
    for (const [name, type] of entries) {
      if (!isDirectoryType(type)) continue;
      const connectionDir = vscode.Uri.joinPath(schemasRoot, name);
      const schema = vscode.Uri.joinPath(connectionDir, 'schema.json');
      if (!await fileExists(schema)) continue;
      bundles.push({
        connectionDir,
        schema,
        description: vscode.Uri.joinPath(connectionDir, 'description.json'),
        customRelationships: vscode.Uri.joinPath(connectionDir, 'custom.relationships.json'),
        erd: vscode.Uri.joinPath(connectionDir, 'erd.json'),
        layout: vscode.Uri.joinPath(connectionDir, 'erd.layout.json'),
      });
    }
    return bundles;
  } catch {
    return [];
  }
}

async function copyFileIfPresent(source: vscode.Uri, destination: vscode.Uri): Promise<boolean> {
  if (!await fileExists(source)) return false;
  const bytes = await vscode.workspace.fs.readFile(source);
  await vscode.workspace.fs.writeFile(destination, bytes);
  return true;
}

async function moveToBackup(source: vscode.Uri, backupRoot: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (!await fileExists(source)) return undefined;
  await vscode.workspace.fs.createDirectory(backupRoot);
  const backupUri = vscode.Uri.joinPath(backupRoot, `${Date.now()}-${source.path.split('/').pop() || source.fsPath}`);
  await vscode.workspace.fs.rename(source, backupUri, { overwrite: true });
  return backupUri;
}

async function appendManifestEntry(
  manifest: MigrationManifest,
  kind: MigrationManifestEntry['kind'],
  source: vscode.Uri,
  backup: vscode.Uri | undefined,
  destination?: vscode.Uri,
  status: MigrationManifestEntry['status'] = 'migrated'
): Promise<void> {
  if (!backup) return;
  manifest.entries.push({
    kind,
    source: source.fsPath,
    destination: destination?.fsPath,
    backup: backup.fsPath,
    status,
  });
}

function splitDescriptionForSchema(
  description: SchemaDescriptionsFile | undefined,
  schemaName: string,
  legacySchema: SchemaIntrospection
): SchemaDescriptionsFile | undefined {
  if (!description) return undefined;
  const prefix = `${schemaName}.`;
  const tables: SchemaDescriptionsFile['tables'] = {};
  const columns: SchemaDescriptionsFile['columns'] = {};

  for (const [key, value] of Object.entries(description.tables || {})) {
    if (key.startsWith(prefix)) tables[key] = value;
  }
  for (const [key, value] of Object.entries(description.columns || {})) {
    if (key.startsWith(prefix)) columns[key] = value;
  }

  return {
    ...description,
    generatedAt: new Date().toISOString(),
    connectionId: legacySchema.connectionId,
    connectionName: legacySchema.connectionName,
    dialect: legacySchema.dialect,
    schemaName,
    tables,
    columns,
  };
}

async function readOptionalJson<T>(uri: vscode.Uri): Promise<T | undefined> {
  try {
    if (!await fileExists(uri)) return undefined;
    return await readJson<T>(uri);
  } catch (err) {
    Logger.warn(`Failed to parse optional migration file ${uri.fsPath}`, err);
    return undefined;
  }
}

async function copySchemaSidecars(
  dpDir: vscode.Uri,
  legacySchema: SchemaIntrospection,
  descriptionUri: vscode.Uri,
  customRelationshipsUri: vscode.Uri,
  erdUri: vscode.Uri,
  layoutUri: vscode.Uri,
  manifest: MigrationManifest
): Promise<void> {
  const description = await readOptionalJson<SchemaDescriptionsFile>(descriptionUri);
  const schemas = legacySchema.schemas || [];

  for (let idx = 0; idx < schemas.length; idx++) {
    const schema = schemas[idx];
    const paths = await resolveSchemaBundlePaths(dpDir, legacySchema.connectionId, legacySchema.connectionName, schema.name);
    const splitDescription = splitDescriptionForSchema(description, schema.name, legacySchema);
    if (splitDescription) {
      await writeJson(paths.description, splitDescription);
    }

    if (schemas.length === 1) {
      await copyFileIfPresent(customRelationshipsUri, paths.customRelationships);
      await copyFileIfPresent(erdUri, paths.erd);
      await copyFileIfPresent(layoutUri, paths.layout);
    } else if (idx === 0) {
      if (await fileExists(customRelationshipsUri)) {
        await copyFileIfPresent(customRelationshipsUri, paths.customRelationships);
      }
      if (await fileExists(erdUri) || await fileExists(layoutUri)) {
        manifest.warnings.push(`Skipped ambiguous ERD migration for multi-schema bundle ${legacySchema.connectionName ?? legacySchema.connectionId}.`);
      }
    }
  }
}

async function migrateLegacyBundle(dpDir: vscode.Uri, files: LegacyBundleFiles, manifest: MigrationManifest): Promise<boolean> {
  if (!await fileExists(files.schema)) return false;

  let legacySchema: SchemaIntrospection;
  try {
    legacySchema = await readJson<SchemaIntrospection>(files.schema);
  } catch (err) {
    manifest.warnings.push(`Failed to parse legacy schema ${files.schema.fsPath}: ${String(err)}`);
    const backup = await moveToBackup(files.schema, getMigrationBackupSchemasRoot(dpDir));
    await appendManifestEntry(manifest, 'orphan', files.schema, backup, undefined, 'backed_up');
    return false;
  }

  if (!legacySchema?.connectionId) {
    manifest.warnings.push(`Skipping legacy schema without connectionId: ${files.schema.fsPath}`);
    const backup = await moveToBackup(files.schema, getMigrationBackupSchemasRoot(dpDir));
    await appendManifestEntry(manifest, 'orphan', files.schema, backup, undefined, 'backed_up');
    return false;
  }

  await saveSchema(legacySchema);
  await copySchemaSidecars(dpDir, legacySchema, files.description, files.customRelationships, files.erd, files.layout, manifest);
  await saveSchema(legacySchema);

  const connectionDir = await resolveSchemaConnectionDir(dpDir, legacySchema.connectionId, legacySchema.connectionName);

  const schemaBackup = await moveToBackup(files.schema, getMigrationBackupSchemasRoot(dpDir));
  await appendManifestEntry(manifest, 'schema', files.schema, schemaBackup, buildConnectionSchemaPaths(connectionDir).manifest);

  const descriptionBackup = await moveToBackup(files.description, getMigrationBackupSchemasRoot(dpDir));
  await appendManifestEntry(manifest, 'description', files.description, descriptionBackup, connectionDir);

  const customRelationshipsBackup = await moveToBackup(files.customRelationships, getMigrationBackupSchemasRoot(dpDir));
  await appendManifestEntry(manifest, 'custom.relationships', files.customRelationships, customRelationshipsBackup, connectionDir);

  const erdBackup = await moveToBackup(files.erd, getMigrationBackupErdRoot(dpDir));
  await appendManifestEntry(manifest, 'erd', files.erd, erdBackup, connectionDir);

  const layoutBackup = await moveToBackup(files.layout, getMigrationBackupErdRoot(dpDir));
  await appendManifestEntry(manifest, 'layout', files.layout, layoutBackup, connectionDir);

  return true;
}

async function migrateConnectionLevelBundle(dpDir: vscode.Uri, files: ConnectionLevelBundleFiles, manifest: MigrationManifest): Promise<boolean> {
  let legacySchema: SchemaIntrospection;
  try {
    legacySchema = await readJson<SchemaIntrospection>(files.schema);
  } catch (err) {
    manifest.warnings.push(`Failed to parse connection-level schema ${files.schema.fsPath}: ${String(err)}`);
    return false;
  }

  if (!legacySchema?.connectionId) {
    manifest.warnings.push(`Skipping connection-level schema without connectionId: ${files.schema.fsPath}`);
    return false;
  }

  await saveSchema(legacySchema);
  await copySchemaSidecars(dpDir, legacySchema, files.description, files.customRelationships, files.erd, files.layout, manifest);
  await saveSchema(legacySchema);

  const connectionBackupRoot = vscode.Uri.joinPath(getMigrationBackupSchemasRoot(dpDir), sanitizeSchemaBundleName(legacySchema.connectionName, legacySchema.connectionId));
  const schemaBackup = await moveToBackup(files.schema, connectionBackupRoot);
  await appendManifestEntry(manifest, 'schema', files.schema, schemaBackup, files.connectionDir);

  const descriptionBackup = await moveToBackup(files.description, connectionBackupRoot);
  await appendManifestEntry(manifest, 'description', files.description, descriptionBackup, files.connectionDir);

  const customRelationshipsBackup = await moveToBackup(files.customRelationships, connectionBackupRoot);
  await appendManifestEntry(manifest, 'custom.relationships', files.customRelationships, customRelationshipsBackup, files.connectionDir);

  const erdBackup = await moveToBackup(files.erd, connectionBackupRoot);
  await appendManifestEntry(manifest, 'erd', files.erd, erdBackup, files.connectionDir);

  const layoutBackup = await moveToBackup(files.layout, connectionBackupRoot);
  await appendManifestEntry(manifest, 'layout', files.layout, layoutBackup, files.connectionDir);
  return true;
}

async function backupRemainingLegacyFiles(dpDir: vscode.Uri, processedSchemaBases: Set<string>, manifest: MigrationManifest): Promise<void> {
  const schemasRoot = getSchemasRoot(dpDir);
  try {
    const schemaEntries = await vscode.workspace.fs.readDirectory(schemasRoot);
    for (const [name] of schemaEntries) {
      if (!name.endsWith('.json')) continue;
      const base = name
        .replace(/\.description\.json$/i, '')
        .replace(/\.custom\.relationships\.json$/i, '')
        .replace(/\.json$/i, '');
      if (processedSchemaBases.has(base)) continue;

      const source = vscode.Uri.joinPath(schemasRoot, name);
      const backup = await moveToBackup(source, getMigrationBackupSchemasRoot(dpDir));
      await appendManifestEntry(manifest, 'orphan', source, backup, undefined, 'backed_up');
    }
  } catch {
    // Ignore absent directory.
  }

  const legacyErdRoot = vscode.Uri.joinPath(dpDir, 'system', 'erd');
  try {
    const erdEntries = await vscode.workspace.fs.readDirectory(legacyErdRoot);
    for (const [name] of erdEntries) {
      if (!name.endsWith('.json')) continue;
      const base = name.replace(/\.erd\.json$/i, '').replace(/\.layout\.json$/i, '');
      if (processedSchemaBases.has(base)) continue;

      const source = vscode.Uri.joinPath(legacyErdRoot, name);
      const backup = await moveToBackup(source, getMigrationBackupErdRoot(dpDir));
      await appendManifestEntry(manifest, 'orphan', source, backup, undefined, 'backed_up');
    }
  } catch {
    // Ignore absent directory.
  }
}

export async function runSchemaBundleMigrationIfNeeded(): Promise<void> {
  const dpDir = await ensureDPDirs();
  const stateUri = getSchemaBundleMigrationStateUri(dpDir);
  if (await fileExists(stateUri)) {
    await normalizeSchemaLevelLayoutFilenames(dpDir);
    await removeLegacyErdDirIfEmpty(dpDir);
    return;
  }

  if (!await hasLegacySchemaStorage(dpDir)) {
    await normalizeSchemaLevelLayoutFilenames(dpDir);
    await removeLegacyErdDirIfEmpty(dpDir);
    return;
  }

  const manifest: MigrationManifest = {
    version: '1',
    startedAt: new Date().toISOString(),
    entries: [],
    warnings: [],
  };

  let migratedBundles = 0;
  try {
    const baseNames = await listLegacySchemaBaseNames(dpDir);
    const processedBases = new Set<string>();

    const connectionLevelBundles = await listConnectionLevelLegacyBundles(dpDir);
    for (const files of connectionLevelBundles) {
      const migrated = await migrateConnectionLevelBundle(dpDir, files, manifest);
      if (migrated) {
        migratedBundles++;
      }
    }

    for (const baseName of baseNames) {
      const migrated = await migrateLegacyBundle(dpDir, legacyBundleFiles(dpDir, baseName), manifest);
      processedBases.add(baseName);
      if (migrated) {
        migratedBundles++;
      }
    }

    await backupRemainingLegacyFiles(dpDir, processedBases, manifest);
    manifest.completedAt = new Date().toISOString();

    await vscode.workspace.fs.createDirectory(getMigrationBackupRoot(dpDir));
    await vscode.workspace.fs.createDirectory(getMigrationBackupSchemasRoot(dpDir));
    await writeJson(getMigrationBackupManifestUri(dpDir), manifest);

    const state: MigrationState = {
      version: '1',
      status: 'complete',
      attemptedAt: manifest.startedAt,
      completedAt: manifest.completedAt,
      migratedBundles,
      backupManifestPath: getMigrationBackupManifestUri(dpDir).fsPath,
    };
    await vscode.workspace.fs.createDirectory(getSchemaMigrationsRoot(dpDir));
    await writeJson(stateUri, state);
    await normalizeSchemaLevelLayoutFilenames(dpDir);
    await removeLegacyErdDirIfEmpty(dpDir);
  } catch (err) {
    manifest.completedAt = new Date().toISOString();
    manifest.warnings.push(`Migration failed: ${String(err)}`);
    await vscode.workspace.fs.createDirectory(getMigrationBackupRoot(dpDir));
    await vscode.workspace.fs.createDirectory(getMigrationBackupSchemasRoot(dpDir));
    await writeJson(getMigrationBackupManifestUri(dpDir), manifest);

    const state: MigrationState = {
      version: '1',
      status: 'failed',
      attemptedAt: manifest.startedAt,
      completedAt: manifest.completedAt,
      error: String(err),
      migratedBundles,
      backupManifestPath: getMigrationBackupManifestUri(dpDir).fsPath,
    };
    await vscode.workspace.fs.createDirectory(getSchemaMigrationsRoot(dpDir));
    await writeJson(stateUri, state);
    await normalizeSchemaLevelLayoutFilenames(dpDir);
    await removeLegacyErdDirIfEmpty(dpDir);
    Logger.error('Schema bundle migration failed', err);
  }
}
