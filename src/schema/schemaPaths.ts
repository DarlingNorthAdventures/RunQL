import * as vscode from 'vscode';
import { Logger } from '../core/logger';
import { SchemaIntrospection } from '../core/types';
import { fileExists, readJson } from '../core/fsWorkspace';

export const SCHEMA_BUNDLE_FILES = {
  schema: 'schema.json',
  description: 'description.json',
  customRelationships: 'custom.relationships.json',
  erd: 'erd.json',
  layout: 'erd.layout.json',
} as const;

export const LEGACY_SCHEMA_BUNDLE_LAYOUT_FILE = 'layout.json';
export const SCHEMA_CONNECTION_MANIFEST_FILE = 'manifest.json';
export const RESERVED_QUERY_CONNECTION_FOLDER = 'Unassigned';

export interface SchemaConnectionManifestEntry {
  name: string;
  path: string;
  descriptionPath: string;
  customRelationshipsPath: string;
  erdPath: string;
  erdLayoutPath: string;
  generatedAt: string;
}

export interface SchemaConnectionManifest {
  version: '0.1';
  connectionId: string;
  connectionName?: string;
  dialect: SchemaIntrospection['dialect'];
  generatedAt: string;
  schemas: SchemaConnectionManifestEntry[];
  stale?: boolean;
  deleted?: boolean;
  deletedAt?: string;
  originalConnectionName?: string;
}

export function sanitizeSchemaBundleName(displayName?: string, fallback?: string): string {
  const base = (displayName && displayName.trim().length > 0) ? displayName.trim() : fallback;
  const safe = String(base || 'connection')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe.length > 0 ? safe : 'connection';
}

export function normalizedConnectionFolderKey(connectionName: string): string {
  return sanitizeSchemaBundleName(connectionName).toLowerCase();
}

export function isReservedConnectionFolderName(connectionName: string): boolean {
  return normalizedConnectionFolderKey(connectionName) === RESERVED_QUERY_CONNECTION_FOLDER.toLowerCase();
}

function isDirectoryType(type: vscode.FileType | number): boolean {
  return type === 2 || (Boolean(vscode.FileType) && type === vscode.FileType.Directory);
}

export function getSchemasRoot(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(dpDir, 'schemas');
}

export function getSchemaMigrationsRoot(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(dpDir, 'system', 'migrations');
}

export function getSchemaBundleMigrationStateUri(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(getSchemaMigrationsRoot(dpDir), 'schema-bundles-v2.json');
}

export function getMigrationBackupRoot(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(dpDir, 'system', 'migration_backup');
}

export function getMigrationBackupSchemasRoot(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(getMigrationBackupRoot(dpDir), 'schema-bundles-v2');
}

export function getMigrationBackupErdRoot(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(getMigrationBackupRoot(dpDir), 'erd');
}

export function getMigrationBackupManifestUri(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(getMigrationBackupSchemasRoot(dpDir), 'manifest.json');
}

export function buildSchemaBundlePaths(bundleDir: vscode.Uri) {
  return {
    bundleDir,
    schema: vscode.Uri.joinPath(bundleDir, SCHEMA_BUNDLE_FILES.schema),
    description: vscode.Uri.joinPath(bundleDir, SCHEMA_BUNDLE_FILES.description),
    customRelationships: vscode.Uri.joinPath(bundleDir, SCHEMA_BUNDLE_FILES.customRelationships),
    erd: vscode.Uri.joinPath(bundleDir, SCHEMA_BUNDLE_FILES.erd),
    layout: vscode.Uri.joinPath(bundleDir, SCHEMA_BUNDLE_FILES.layout),
  };
}

export function buildConnectionSchemaPaths(connectionDir: vscode.Uri) {
  return {
    connectionDir,
    manifest: vscode.Uri.joinPath(connectionDir, SCHEMA_CONNECTION_MANIFEST_FILE),
  };
}

export function buildSchemaBundlePathsForSchema(connectionDir: vscode.Uri, schemaName: string): ReturnType<typeof buildSchemaBundlePaths> {
  return buildSchemaBundlePaths(vscode.Uri.joinPath(connectionDir, sanitizeSchemaBundleName(schemaName, 'schema')));
}

export async function listSchemaConnectionDirs(dpDir: vscode.Uri, includeDeleted = false): Promise<vscode.Uri[]> {
  const root = getSchemasRoot(dpDir);
  try {
    const entries = await vscode.workspace.fs.readDirectory(root);
    const dirs: vscode.Uri[] = [];
    for (const [name, type] of entries) {
      if (!isDirectoryType(type)) continue;
      if (!includeDeleted && name.endsWith('_deleted')) continue;
      const candidate = vscode.Uri.joinPath(root, name);
      if (
        await fileExists(vscode.Uri.joinPath(candidate, SCHEMA_CONNECTION_MANIFEST_FILE)) ||
        await hasSchemaChildren(candidate) ||
        await fileExists(vscode.Uri.joinPath(candidate, SCHEMA_BUNDLE_FILES.schema))
      ) {
        dirs.push(candidate);
      }
    }
    return dirs;
  } catch (err) {
    Logger.warn(`Failed to enumerate schema bundles in ${root.fsPath}`, err);
    return [];
  }
}

async function hasSchemaChildren(connectionDir: vscode.Uri): Promise<boolean> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(connectionDir);
    for (const [name, type] of entries) {
      if (!isDirectoryType(type)) continue;
      if (await fileExists(vscode.Uri.joinPath(connectionDir, name, SCHEMA_BUNDLE_FILES.schema))) {
        return true;
      }
    }
  } catch {
    // Ignore unreadable folders.
  }
  return false;
}

export async function listSchemaBundleDirs(dpDir: vscode.Uri): Promise<vscode.Uri[]> {
  const connectionDirs = await listSchemaConnectionDirs(dpDir);
  const bundleDirs: vscode.Uri[] = [];

  for (const connectionDir of connectionDirs) {
    try {
      const entries = await vscode.workspace.fs.readDirectory(connectionDir);
      for (const [name, type] of entries) {
        if (!isDirectoryType(type)) continue;
        const candidate = vscode.Uri.joinPath(connectionDir, name);
        if (await fileExists(vscode.Uri.joinPath(candidate, SCHEMA_BUNDLE_FILES.schema))) {
          bundleDirs.push(candidate);
        }
      }
    } catch (err) {
      Logger.warn(`Failed to enumerate schema bundles in ${connectionDir.fsPath}`, err);
    }
  }

  return bundleDirs;
}

async function readBundleSchema(bundleDir: vscode.Uri): Promise<SchemaIntrospection | undefined> {
  try {
    return await readJson<SchemaIntrospection>(vscode.Uri.joinPath(bundleDir, SCHEMA_BUNDLE_FILES.schema));
  } catch (err) {
    Logger.warn(`Failed to read schema bundle ${bundleDir.fsPath}`, err);
    return undefined;
  }
}

export async function findSchemaConnectionDirByConnectionId(dpDir: vscode.Uri, connectionId: string, includeDeleted = false): Promise<vscode.Uri | undefined> {
  const connectionDirs = await listSchemaConnectionDirs(dpDir, includeDeleted);
  for (const connectionDir of connectionDirs) {
    try {
      const manifest = await readJson<SchemaConnectionManifest>(vscode.Uri.joinPath(connectionDir, SCHEMA_CONNECTION_MANIFEST_FILE));
      if (manifest?.connectionId === connectionId) {
        return connectionDir;
      }
    } catch {
      // Fall back to scanning child bundles below.
    }

    const bundleDirs = await listSchemaBundleDirsInConnection(connectionDir);
    for (const bundleDir of bundleDirs) {
      const schema = await readBundleSchema(bundleDir);
      if (schema?.connectionId === connectionId) {
        return connectionDir;
      }
    }
  }
  return undefined;
}

export async function listSchemaBundleDirsInConnection(connectionDir: vscode.Uri): Promise<vscode.Uri[]> {
  const dirs: vscode.Uri[] = [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(connectionDir);
    for (const [name, type] of entries) {
      if (!isDirectoryType(type)) continue;
      const candidate = vscode.Uri.joinPath(connectionDir, name);
      if (await fileExists(vscode.Uri.joinPath(candidate, SCHEMA_BUNDLE_FILES.schema))) {
        dirs.push(candidate);
      }
    }
  } catch {
    // Ignore absent connection folder.
  }
  return dirs;
}

function shortConnectionId(connectionId: string): string {
  return connectionId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bundle';
}

export async function resolveSchemaBundleDir(
  dpDir: vscode.Uri,
  connectionId: string,
  connectionName?: string,
  schemaName = 'main'
): Promise<vscode.Uri> {
  const connectionDir = await resolveSchemaConnectionDir(dpDir, connectionId, connectionName);
  return vscode.Uri.joinPath(connectionDir, sanitizeSchemaBundleName(schemaName, 'schema'));
}

export async function resolveSchemaConnectionDir(
  dpDir: vscode.Uri,
  connectionId: string,
  connectionName?: string
): Promise<vscode.Uri> {
  const existing = await findSchemaConnectionDirByConnectionId(dpDir, connectionId);
  if (existing) return existing;

  const root = getSchemasRoot(dpDir);
  const preferredName = sanitizeSchemaBundleName(connectionName, connectionId);
  const preferredDir = vscode.Uri.joinPath(root, preferredName);
  if (!await fileExists(preferredDir)) {
    return preferredDir;
  }

  try {
    const manifest = await readJson<SchemaConnectionManifest>(vscode.Uri.joinPath(preferredDir, SCHEMA_CONNECTION_MANIFEST_FILE));
    if (manifest?.connectionId === connectionId) {
      return preferredDir;
    }
  } catch {
    // Fall through.
  }

  const bundleDirs = await listSchemaBundleDirsInConnection(preferredDir);
  for (const bundleDir of bundleDirs) {
    const existingSchema = await readBundleSchema(bundleDir);
    if (existingSchema?.connectionId === connectionId) {
      return preferredDir;
    }
  }

  const existingSchema = await readBundleSchema(preferredDir);
  if (existingSchema?.connectionId === connectionId) {
    return preferredDir;
  }

  try {
    const entries = await vscode.workspace.fs.readDirectory(preferredDir);
    if (entries.length === 0) {
      return preferredDir;
    }
  } catch {
    // Fall through to suffixed directory.
  }

  return vscode.Uri.joinPath(root, `${preferredName}--${shortConnectionId(connectionId)}`);
}

export async function resolveSchemaBundlePaths(
  dpDir: vscode.Uri,
  connectionId: string,
  connectionName?: string,
  schemaName = 'main'
) {
  const bundleDir = await resolveSchemaBundleDir(dpDir, connectionId, connectionName, schemaName);
  return buildSchemaBundlePaths(bundleDir);
}

export async function resolveSchemaConnectionPaths(
  dpDir: vscode.Uri,
  connectionId: string,
  connectionName?: string
): Promise<ReturnType<typeof buildConnectionSchemaPaths>> {
  const connectionDir = await resolveSchemaConnectionDir(dpDir, connectionId, connectionName);
  return buildConnectionSchemaPaths(connectionDir);
}

export async function getDescriptionUriForSchema(
  dpDir: vscode.Uri,
  connectionId: string,
  connectionName: string | undefined,
  schemaName: string
): Promise<vscode.Uri> {
  const paths = await resolveSchemaBundlePaths(dpDir, connectionId, connectionName, schemaName);
  return paths.description;
}

export async function getDescriptionUriForConnection(
  dpDir: vscode.Uri,
  connectionId: string,
  connectionName?: string,
  schemaName = 'main'
): Promise<vscode.Uri> {
  return getDescriptionUriForSchema(dpDir, connectionId, connectionName, schemaName);
}
