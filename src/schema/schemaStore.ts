
import * as vscode from 'vscode';
import {
  SchemaIntrospection,
  CustomRelationshipsFile,
  CustomRelationship,
  SchemaModel,
  RoutineModel,
  RoutineParameterModel,
} from '../core/types';
import { ensureDPDirs, readJson, writeJson, fileExists } from '../core/fsWorkspace';
import { SchemaDescriptionsFile } from './descriptionStore';
import { Logger } from '../core/logger';
import {
  SchemaConnectionManifest,
  buildSchemaBundlePaths,
  buildConnectionSchemaPaths,
  listSchemaBundleDirsInConnection,
  listSchemaConnectionDirs,
  resolveSchemaConnectionDir,
  resolveSchemaBundlePaths,
  sanitizeSchemaBundleName,
} from './schemaPaths';

function normalizeRoutineModel(rawRoutine: Record<string, unknown>, fallbackKind: 'procedure' | 'function'): RoutineModel {
  const kind = rawRoutine?.kind === 'procedure' || rawRoutine?.kind === 'function'
    ? rawRoutine.kind
    : fallbackKind;
  return {
    name: String(rawRoutine?.name ?? ''),
    kind,
    comment: typeof rawRoutine?.comment === 'string' ? rawRoutine.comment : undefined,
    returnType: typeof rawRoutine?.returnType === 'string' ? rawRoutine.returnType : undefined,
    language: typeof rawRoutine?.language === 'string' ? rawRoutine.language : undefined,
    deterministic: typeof rawRoutine?.deterministic === 'boolean' ? rawRoutine.deterministic : undefined,
    schemaQualifiedName: typeof rawRoutine?.schemaQualifiedName === 'string' ? rawRoutine.schemaQualifiedName : undefined,
    signature: typeof rawRoutine?.signature === 'string' ? rawRoutine.signature : undefined,
    parameters: Array.isArray(rawRoutine?.parameters)
      ? (rawRoutine.parameters as Record<string, unknown>[])
        .map((p: Record<string, unknown>): RoutineParameterModel => ({
          name: String(p?.name ?? ''),
          mode: typeof p?.mode === 'string' ? p.mode as RoutineParameterModel['mode'] : undefined,
          type: typeof p?.type === 'string' ? p.type : undefined,
          position: typeof p?.position === 'number' ? p.position : undefined,
        }))
        .filter(p => p.name.length > 0)
      : [],
  };
}

function normalizeSchemaModel(rawSchema: Record<string, unknown>): SchemaModel {
  const tables = Array.isArray(rawSchema?.tables) ? rawSchema.tables : [];
  const views = Array.isArray(rawSchema?.views) ? rawSchema.views : [];
  const procedures = Array.isArray(rawSchema?.procedures)
    ? rawSchema.procedures.map((routine: Record<string, unknown>) => normalizeRoutineModel(routine, 'procedure'))
    : [];
  const functions = Array.isArray(rawSchema?.functions)
    ? rawSchema.functions.map((routine: Record<string, unknown>) => normalizeRoutineModel(routine, 'function'))
    : [];

  return {
    name: String(rawSchema?.name ?? ''),
    tables,
    views,
    procedures,
    functions,
  };
}

function normalizeSchemaIntrospection(rawSchema: Record<string, unknown>): SchemaIntrospection | undefined {
  if (!rawSchema || !rawSchema.connectionId) return undefined;
  const schemas = Array.isArray(rawSchema.schemas)
    ? (rawSchema.schemas as Record<string, unknown>[]).map(normalizeSchemaModel)
    : [];
  return {
    version: rawSchema.version === '0.2' ? '0.2' : '0.1',
    generatedAt: typeof rawSchema.generatedAt === 'string' ? rawSchema.generatedAt : new Date().toISOString(),
    connectionId: String(rawSchema.connectionId),
    connectionName: typeof rawSchema.connectionName === 'string' ? rawSchema.connectionName : undefined,
    dialect: String(rawSchema.dialect ?? '') as SchemaIntrospection['dialect'],
    docPath: typeof rawSchema.docPath === 'string' ? rawSchema.docPath : undefined,
    customRelationshipsPath: typeof rawSchema.customRelationshipsPath === 'string' ? rawSchema.customRelationshipsPath : undefined,
    schemas,
  };
}

/**
 * Monotonically increasing counter that bumps whenever schemas are
 * saved, deleted, or renamed. Consumers can compare their last-seen
 * version to decide if cached data is stale.
 */
let schemaVersion = 0;

export function getSchemaVersion(): number {
  return schemaVersion;
}

export function bumpSchemaVersion(): void {
  schemaVersion++;
}

function buildDefaultDescription(normalized: SchemaIntrospection, schemaName?: string): SchemaDescriptionsFile {
  return {
    __runqlHeader: "#RunQL created",
    version: "0.1",
    generatedAt: new Date().toISOString(),
    connectionId: normalized.connectionId,
    connectionName: normalized.connectionName,
    dialect: normalized.dialect,
    schemaName: schemaName || normalized.schemas?.[0]?.name || 'main',
    tables: {},
    columns: {}
  };
}

function buildDefaultCustomRelationships(normalized: SchemaIntrospection): CustomRelationshipsFile {
  return {
    version: "0.1",
    connectionId: normalized.connectionId,
    connectionName: normalized.connectionName,
    relationships: []
  };
}

function buildOrderedIntrospection(
  normalized: SchemaIntrospection,
  schema: SchemaModel,
  paths: ReturnType<typeof buildSchemaBundlePaths>
): SchemaIntrospection {
  return {
    version: "0.2",
    generatedAt: normalized.generatedAt,
    connectionId: normalized.connectionId,
    connectionName: normalized.connectionName,
    dialect: normalized.dialect,
    docPath: paths.description.fsPath,
    customRelationshipsPath: paths.customRelationships.fsPath,
    schemas: [schema]
  };
}

async function ensureBundleFiles(
  paths: ReturnType<typeof buildSchemaBundlePaths>,
  normalized: SchemaIntrospection,
  schemaName?: string
): Promise<void> {
  await vscode.workspace.fs.createDirectory(paths.bundleDir);

  if (!await fileExists(paths.description)) {
    await writeJson(paths.description, buildDefaultDescription(normalized, schemaName));
  }

  if (!await fileExists(paths.customRelationships)) {
    await writeJson(paths.customRelationships, buildDefaultCustomRelationships(normalized));
  }
}

async function updateJsonFile<T extends object>(
  uri: vscode.Uri,
  updater: (data: T) => boolean | void
): Promise<void> {
  try {
    if (!await fileExists(uri)) return;
    const data = await readJson<T>(uri);
    const changed = updater(data);
    if (changed !== false) {
      await writeJson(uri, data);
    }
  } catch (err) {
    Logger.warn(`Failed to update JSON file ${uri.fsPath}`, err);
  }
}

async function resolveRenameTargetBundleDir(
  dpDir: vscode.Uri,
  connectionId: string,
  currentBundleDir: vscode.Uri | undefined,
  newName: string
): Promise<vscode.Uri> {
  const root = vscode.Uri.joinPath(dpDir, 'schemas');
  const preferredName = sanitizeSchemaBundleName(newName, connectionId);
  const preferredDir = vscode.Uri.joinPath(root, preferredName);

  if (!currentBundleDir || currentBundleDir.fsPath === preferredDir.fsPath) {
    return preferredDir;
  }

  if (!await fileExists(preferredDir)) {
    return preferredDir;
  }

  try {
    const existing = await readJson<SchemaConnectionManifest>(vscode.Uri.joinPath(preferredDir, 'manifest.json'));
    if (existing?.connectionId === connectionId) {
      return preferredDir;
    }
  } catch {
    // Fall through to suffixed directory.
  }

  return vscode.Uri.joinPath(root, `${preferredName}--${connectionId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bundle'}`);
}

async function loadSchemaBundle(bundleDir: vscode.Uri): Promise<SchemaIntrospection | undefined> {
  const schemaUri = vscode.Uri.joinPath(bundleDir, 'schema.json');
  try {
    const raw = await readJson<Record<string, unknown>>(schemaUri);
    const normalized = normalizeSchemaIntrospection(raw);
    if (!normalized) return undefined;
    normalized.docPath = vscode.Uri.joinPath(bundleDir, 'description.json').fsPath;
    normalized.customRelationshipsPath = vscode.Uri.joinPath(bundleDir, 'custom.relationships.json').fsPath;
    return normalized;
  } catch (err) {
    Logger.warn(`Failed to parse schema bundle ${bundleDir.fsPath}`, err);
    return undefined;
  }
}

function mergeSchemaIntrospection(
  target: SchemaIntrospection | undefined,
  next: SchemaIntrospection
): SchemaIntrospection {
  if (!target) {
    return {
      ...next,
      schemas: [...next.schemas],
    };
  }

  const existingSchemaNames = new Set(target.schemas.map(s => s.name));
  for (const schema of next.schemas) {
    if (!existingSchemaNames.has(schema.name)) {
      target.schemas.push(schema);
      existingSchemaNames.add(schema.name);
    } else {
      const idx = target.schemas.findIndex(s => s.name === schema.name);
      target.schemas[idx] = schema;
    }
  }

  if (next.generatedAt > target.generatedAt) {
    target.generatedAt = next.generatedAt;
  }
  target.connectionName = next.connectionName ?? target.connectionName;
  target.dialect = next.dialect || target.dialect;
  target.docPath = target.docPath ?? next.docPath;
  target.customRelationshipsPath = target.customRelationshipsPath ?? next.customRelationshipsPath;
  return target;
}

function workspaceRelative(uri: vscode.Uri): string {
  if (typeof vscode.workspace.asRelativePath === 'function') {
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? uri.fsPath.replace(`${root}/`, '').replace(/\\/g, '/') : uri.fsPath;
}

function uriBaseName(uri: vscode.Uri): string {
  const normalized = uri.fsPath.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.split('/').pop() || 'schema';
}

function timestampSuffix(value: string): string {
  return value.replace(/[^0-9]/g, '').slice(0, 14) || 'deleted';
}

async function resolveDeletedSchemaArchiveDir(
  dpDir: vscode.Uri,
  connectionId: string,
  connectionName: string | undefined,
  schemaName: string,
  deletedAt: string
): Promise<vscode.Uri> {
  const deletedConnectionDir = vscode.Uri.joinPath(
    dpDir,
    'schemas',
    'deleted',
    sanitizeSchemaBundleName(connectionName, connectionId)
  );
  await vscode.workspace.fs.createDirectory(deletedConnectionDir);

  const preferredName = sanitizeSchemaBundleName(schemaName, 'schema');
  const preferredDir = vscode.Uri.joinPath(deletedConnectionDir, preferredName);
  if (!await fileExists(preferredDir)) {
    return preferredDir;
  }

  const suffix = timestampSuffix(deletedAt);
  let attempt = vscode.Uri.joinPath(deletedConnectionDir, `${preferredName}--${suffix}`);
  let index = 2;
  while (await fileExists(attempt)) {
    attempt = vscode.Uri.joinPath(deletedConnectionDir, `${preferredName}--${suffix}-${index}`);
    index++;
  }
  return attempt;
}

async function archiveSchemaBundlesMissingFromIntrospection(
  dpDir: vscode.Uri,
  connectionDir: vscode.Uri,
  normalized: SchemaIntrospection
): Promise<void> {
  const currentSchemaNames = new Set(normalized.schemas.map(schema => schema.name));
  const currentBundleNames = new Set(normalized.schemas.map(schema => sanitizeSchemaBundleName(schema.name, 'schema')));
  const existingBundleDirs = await listSchemaBundleDirsInConnection(connectionDir);
  const deletedAt = new Date().toISOString();

  if (normalized.schemas.length === 0 && existingBundleDirs.length > 0) {
    Logger.warn(
      `Skipping deleted-schema archival for ${normalized.connectionName ?? normalized.connectionId}: introspection returned no schemas.`
    );
    return;
  }

  for (const bundleDir of existingBundleDirs) {
    const loaded = await loadSchemaBundle(bundleDir);
    const existingSchemaName = loaded?.schemas?.[0]?.name || uriBaseName(bundleDir);
    const existingBundleName = uriBaseName(bundleDir);
    if (currentSchemaNames.has(existingSchemaName) || currentBundleNames.has(existingBundleName)) {
      continue;
    }

    const archiveDir = await resolveDeletedSchemaArchiveDir(
      dpDir,
      normalized.connectionId,
      normalized.connectionName,
      existingSchemaName,
      deletedAt
    );

    try {
      await vscode.workspace.fs.rename(bundleDir, archiveDir, { overwrite: false });
      const paths = buildSchemaBundlePaths(archiveDir);
      await updateJsonFile<Record<string, unknown>>(paths.schema, (schema) => {
        schema.stale = true;
        schema.deleted = true;
        schema.deletedAt = deletedAt;
      });
    } catch (err) {
      Logger.warn(`Failed to archive deleted schema folder ${bundleDir.fsPath}`, err);
    }
  }
}

async function writeConnectionManifest(
  dpDir: vscode.Uri,
  connectionDir: vscode.Uri,
  connectionId: string,
  connectionName: string | undefined,
  dialect: SchemaIntrospection['dialect']
): Promise<void> {
  const bundleDirs = await listSchemaBundleDirsInConnection(connectionDir);
  const schemas: SchemaConnectionManifest['schemas'] = [];

  for (const bundleDir of bundleDirs) {
    const loaded = await loadSchemaBundle(bundleDir);
    const schema = loaded?.schemas?.[0];
    if (!loaded || !schema) continue;
    const paths = buildSchemaBundlePaths(bundleDir);
    schemas.push({
      name: schema.name,
      path: workspaceRelative(paths.schema),
      descriptionPath: workspaceRelative(paths.description),
      customRelationshipsPath: workspaceRelative(paths.customRelationships),
      erdPath: workspaceRelative(paths.erd),
      erdLayoutPath: workspaceRelative(paths.layout),
      generatedAt: loaded.generatedAt,
    });
  }

  schemas.sort((a, b) => a.name.localeCompare(b.name));
  const manifest: SchemaConnectionManifest = {
    version: '0.1',
    connectionId,
    connectionName,
    dialect,
    generatedAt: new Date().toISOString(),
    schemas,
  };
  await vscode.workspace.fs.createDirectory(connectionDir);
  await writeJson(buildConnectionSchemaPaths(connectionDir).manifest, manifest);
}

export async function loadSchemas(): Promise<SchemaIntrospection[]> {
  const dpDir = await ensureDPDirs();
  const connectionDirs = await listSchemaConnectionDirs(dpDir);
  const schemaMap = new Map<string, SchemaIntrospection>();

  for (const connectionDir of connectionDirs) {
    const bundleDirs = await listSchemaBundleDirsInConnection(connectionDir);
    for (const bundleDir of bundleDirs) {
      const normalized = await loadSchemaBundle(bundleDir);
      if (!normalized) continue;
      const existing = schemaMap.get(normalized.connectionId);
      schemaMap.set(normalized.connectionId, mergeSchemaIntrospection(existing, normalized));
    }
  }

  return Array.from(schemaMap.values()).map(schema => ({
    ...schema,
    schemas: [...schema.schemas].sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

export async function saveSchema(introspection: SchemaIntrospection) {
  bumpSchemaVersion();
  const normalized = normalizeSchemaIntrospection(introspection as unknown as Record<string, unknown>);
  if (!normalized) {
    throw new Error('Invalid schema introspection payload');
  }

  const dpDir = await ensureDPDirs();
  const connectionDir = await resolveSchemaConnectionDir(dpDir, normalized.connectionId, normalized.connectionName);
  await vscode.workspace.fs.createDirectory(connectionDir);
  await archiveSchemaBundlesMissingFromIntrospection(dpDir, connectionDir, normalized);

  for (const schema of normalized.schemas) {
    const paths = buildSchemaBundlePaths(vscode.Uri.joinPath(connectionDir, sanitizeSchemaBundleName(schema.name, 'schema')));
    await ensureBundleFiles(paths, normalized, schema.name);
    await writeJson(paths.schema, buildOrderedIntrospection(normalized, schema, paths));
  }

  await writeConnectionManifest(dpDir, connectionDir, normalized.connectionId, normalized.connectionName, normalized.dialect);
}

export async function deleteSchema(connectionId: string, connectionName?: string) {
  bumpSchemaVersion();
  const dpDir = await ensureDPDirs();
  const bundleDir = await resolveSchemaConnectionDir(dpDir, connectionId, connectionName);
  try {
    if (await fileExists(bundleDir)) {
      await vscode.workspace.fs.delete(bundleDir, { recursive: true, useTrash: false });
    }
  } catch (err) {
    Logger.warn(`Failed to delete schema bundle ${bundleDir.fsPath}`, err);
  }
}

export async function renameSchemaFiles(connectionId: string, oldName: string, newName: string) {
  bumpSchemaVersion();
  const dpDir = await ensureDPDirs();
  const currentBundleDir = await resolveSchemaConnectionDir(dpDir, connectionId, oldName);
  if (!await fileExists(currentBundleDir)) return;

  const targetBundleDir = await resolveRenameTargetBundleDir(dpDir, connectionId, currentBundleDir, newName);
  if (currentBundleDir.fsPath !== targetBundleDir.fsPath) {
    try {
      await vscode.workspace.fs.rename(currentBundleDir, targetBundleDir, { overwrite: true });
    } catch (err) {
      Logger.warn(`Failed to rename schema bundle ${currentBundleDir.fsPath}`, err);
      return;
    }
  }

  const bundleDirs = await listSchemaBundleDirsInConnection(targetBundleDir);
  let dialect: SchemaIntrospection['dialect'] = '';
  for (const bundleDir of bundleDirs) {
    const paths = buildSchemaBundlePaths(bundleDir);
    await updateJsonFile<SchemaIntrospection>(paths.schema, (schema) => {
      schema.connectionName = newName;
      schema.docPath = paths.description.fsPath;
      schema.customRelationshipsPath = paths.customRelationships.fsPath;
      dialect = schema.dialect || dialect;
    });
    await updateJsonFile<SchemaDescriptionsFile>(paths.description, (description) => {
      description.connectionName = newName;
    });
    await updateJsonFile<CustomRelationshipsFile>(paths.customRelationships, (customRelationships) => {
      customRelationships.connectionName = newName;
    });
    await updateJsonFile<Record<string, unknown>>(paths.layout, (layout) => {
      layout.connectionName = newName;
    });
  }
  await writeConnectionManifest(dpDir, targetBundleDir, connectionId, newName, dialect);
}

export async function archiveSchemaFilesForDeletedConnection(connectionId: string, connectionName?: string): Promise<void> {
  bumpSchemaVersion();
  const dpDir = await ensureDPDirs();
  const currentDir = await resolveSchemaConnectionDir(dpDir, connectionId, connectionName);
  if (!await fileExists(currentDir)) return;

  const deletedAt = new Date().toISOString();
  const targetBaseName = `${sanitizeSchemaBundleName(connectionName, connectionId)}_deleted`;
  let targetDir = vscode.Uri.joinPath(vscode.Uri.joinPath(dpDir, 'schemas'), targetBaseName);
  if (await fileExists(targetDir)) {
    targetDir = vscode.Uri.joinPath(vscode.Uri.joinPath(dpDir, 'schemas'), `${targetBaseName}--${connectionId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bundle'}`);
  }

  try {
    await vscode.workspace.fs.rename(currentDir, targetDir, { overwrite: false });
  } catch (err) {
    Logger.warn(`Failed to archive schema folder ${currentDir.fsPath}`, err);
    return;
  }

  const bundleDirs = await listSchemaBundleDirsInConnection(targetDir);
  let dialect: SchemaIntrospection['dialect'] = '';
  for (const bundleDir of bundleDirs) {
    const paths = buildSchemaBundlePaths(bundleDir);
    await updateJsonFile<Record<string, unknown>>(paths.schema, (schema) => {
      schema.stale = true;
      schema.deleted = true;
      schema.deletedAt = deletedAt;
      dialect = String(schema.dialect ?? dialect) as SchemaIntrospection['dialect'];
    });
  }

  const manifestUri = buildConnectionSchemaPaths(targetDir).manifest;
  await updateJsonFile<SchemaConnectionManifest>(manifestUri, (manifest) => {
    manifest.stale = true;
    manifest.deleted = true;
    manifest.deletedAt = deletedAt;
    manifest.originalConnectionName = connectionName;
  });
}

// Custom Relationships Management
export async function loadCustomRelationships(customRelationshipsPath: string): Promise<CustomRelationship[]> {
  try {
    const uri = vscode.Uri.file(customRelationshipsPath);
    const file = await readJson<CustomRelationshipsFile>(uri);
    return file?.relationships || [];
  } catch (_e) {
    Logger.warn('Failed to load custom relationships:', _e);
    return [];
  }
}

export async function saveCustomRelationships(
  connectionId: string,
  connectionName: string,
  relationships: CustomRelationship[],
  schemaName = 'main'
) {
  const dpDir = await ensureDPDirs();
  const paths = await resolveSchemaBundlePaths(dpDir, connectionId, connectionName, schemaName);
  await vscode.workspace.fs.createDirectory(paths.bundleDir);

  const file: CustomRelationshipsFile = {
    version: "0.1",
    connectionId,
    connectionName,
    relationships
  };

  await writeJson(paths.customRelationships, file);
}
