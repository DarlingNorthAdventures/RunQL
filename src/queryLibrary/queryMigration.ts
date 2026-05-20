import * as vscode from 'vscode';
import * as path from 'path';
import { ConnectionProfile } from '../core/types';
import { ensureDPDirs, fileExists, readJson, writeJson } from '../core/fsWorkspace';
import { loadConnectionProfiles } from '../connections/connectionStore';
import { Logger } from '../core/logger';
import { normalizedConnectionFolderKey } from '../schema/schemaPaths';
import { QueryIndexFile } from './queryIndexer';
import { parseMdMetadata } from './mdParser';
import {
  UNASSIGNED_QUERY_FOLDER,
  getConnectionQueriesDir,
  getQueriesRoot,
  sanitizeQueryConnectionFolderName,
} from './queryStorage';
import { rebuildQueryIndex } from './queryIndexer';

interface QueryMigrationState {
  version: '1';
  status: 'complete' | 'failed';
  attemptedAt: string;
  completedAt?: string;
  error?: string;
  movedBundles: number;
}

interface QueryMigrationManifest {
  version: '1';
  startedAt: string;
  completedAt?: string;
  moved: Array<{ source: string; destination: string; connectionFolder: string; collision?: boolean }>;
  skipped: string[];
  warnings: string[];
}

const RECOGNIZED_SIDECARS = ['.md', '.chartconfig.json'];
const SQL_EXTENSIONS = ['.sql', '.postgres'];

function getStateUri(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(dpDir, 'system', 'migrations', 'query-folders-v1.json');
}

function getManifestUri(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(dpDir, 'system', 'migration_backup', 'query-folders-v1-manifest.json');
}

function isDirectoryType(type: vscode.FileType | number): boolean {
  return type === 2 || (Boolean(vscode.FileType) && type === vscode.FileType.Directory);
}

async function walkFiles(dir: vscode.Uri): Promise<vscode.Uri[]> {
  const files: vscode.Uri[] = [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [name, type] of entries) {
      const child = vscode.Uri.joinPath(dir, name);
      if (isDirectoryType(type)) {
        files.push(...await walkFiles(child));
      } else {
        files.push(child);
      }
    }
  } catch {
    // Ignore absent directory.
  }
  return files;
}

function workspaceRelative(uri: vscode.Uri): string {
  if (typeof vscode.workspace.asRelativePath === 'function') {
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? uri.fsPath.replace(`${root}/`, '').replace(/\\/g, '/') : uri.fsPath;
}

function relativeUnder(root: vscode.Uri, file: vscode.Uri): string {
  return path.relative(root.fsPath, file.fsPath).replace(/\\/g, '/');
}

function sqlExtension(file: vscode.Uri): string | undefined {
  const lower = file.path.toLowerCase();
  return SQL_EXTENSIONS.find(ext => lower.endsWith(ext));
}

function baseWithoutSqlExtension(file: vscode.Uri): string {
  const ext = sqlExtension(file) || path.extname(file.fsPath);
  return file.fsPath.slice(0, -ext.length);
}

async function loadExistingIndex(dpDir: vscode.Uri): Promise<QueryIndexFile | undefined> {
  const uri = vscode.Uri.joinPath(dpDir, 'system', 'queries', 'queryIndex.json');
  try {
    if (!await fileExists(uri)) return undefined;
    return await readJson<QueryIndexFile>(uri);
  } catch {
    return undefined;
  }
}

async function readCompanionMetadata(sqlFile: vscode.Uri): Promise<ReturnType<typeof parseMdMetadata> | undefined> {
  const mdUri = vscode.Uri.file(`${baseWithoutSqlExtension(sqlFile)}.md`);
  try {
    if (!await fileExists(mdUri)) return undefined;
    const bytes = await vscode.workspace.fs.readFile(mdUri);
    return parseMdMetadata(Buffer.from(bytes).toString('utf8'));
  } catch {
    return undefined;
  }
}

function resolveProfileByMetadata(
  metadata: ReturnType<typeof parseMdMetadata> | undefined,
  indexEntry: QueryIndexFile['queries'][number] | undefined,
  profiles: ConnectionProfile[]
): ConnectionProfile | undefined {
  const connectionId = metadata?.connectionId || indexEntry?.connectionId || undefined;
  if (connectionId) {
    const byId = profiles.find(profile => profile.id === connectionId);
    if (byId) return byId;
  }

  const connectionName = metadata?.connectionName || indexEntry?.connectionName || undefined;
  if (connectionName) {
    const key = normalizedConnectionFolderKey(connectionName);
    return profiles.find(profile => normalizedConnectionFolderKey(profile.name) === key);
  }

  return undefined;
}

function isAlreadyUnderConnectionFolder(relPath: string, profiles: ConnectionProfile[]): boolean {
  const first = relPath.split('/')[0];
  if (!first) return false;
  if (first === UNASSIGNED_QUERY_FOLDER || first.endsWith('_deleted')) return true;
  const firstKey = first.toLowerCase();
  return profiles.some(profile => normalizedConnectionFolderKey(profile.name) === firstKey);
}

async function collectBundle(sqlFile: vscode.Uri): Promise<vscode.Uri[]> {
  const ext = sqlExtension(sqlFile);
  if (!ext) return [];
  const base = baseWithoutSqlExtension(sqlFile);
  const files = [sqlFile];

  for (const sidecarExt of RECOGNIZED_SIDECARS) {
    const sidecar = vscode.Uri.file(`${base}${sidecarExt}`);
    if (await fileExists(sidecar)) files.push(sidecar);
  }

  const siblingSqlExt = ext === '.sql' ? '.postgres' : '.sql';
  const siblingSql = vscode.Uri.file(`${base}${siblingSqlExt}`);
  if (await fileExists(siblingSql)) files.push(siblingSql);

  return files;
}

async function nextAvailableTarget(targetSql: vscode.Uri): Promise<{ sql: vscode.Uri; suffix: string; collision: boolean }> {
  if (!await fileExists(targetSql)) return { sql: targetSql, suffix: '', collision: false };

  const ext = sqlExtension(targetSql) || path.extname(targetSql.fsPath);
  const base = targetSql.fsPath.slice(0, -ext.length);
  let idx = 2;
  while (true) {
    const candidate = vscode.Uri.file(`${base}_${idx}${ext}`);
    if (!await fileExists(candidate)) {
      return { sql: candidate, suffix: `_${idx}`, collision: true };
    }
    idx++;
  }
}

function updateSourcePath(content: string, sourcePath: string): string {
  if (!content.startsWith('---')) return content;
  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return content;
  const head = content.slice(0, endIdx);
  const rest = content.slice(endIdx);
  const line = `source_path: "${sourcePath.replace(/"/g, '\\"')}"`;
  if (/^source_path:\s*.*$/m.test(head)) {
    return `${head.replace(/^source_path:\s*.*$/m, line)}${rest}`;
  }
  return `${head}\n${line}${rest}`;
}

async function moveBundle(
  bundle: vscode.Uri[],
  sourceSql: vscode.Uri,
  targetSql: vscode.Uri,
  suffix: string
): Promise<void> {
  const sourceBase = baseWithoutSqlExtension(sourceSql);
  const targetBase = baseWithoutSqlExtension(targetSql);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetSql.fsPath)));

  for (const source of bundle) {
    const sourcePath = source.fsPath;
    const targetPath = sourcePath === sourceSql.fsPath
      ? targetSql.fsPath
      : `${targetBase}${suffix ? sourcePath.slice(sourceBase.length).replace(/^(_\d+)?/, '') : sourcePath.slice(sourceBase.length)}`;
    const target = vscode.Uri.file(targetPath);
    await vscode.workspace.fs.rename(source, target, { overwrite: false });

    if (target.path.toLowerCase().endsWith('.md')) {
      const bytes = await vscode.workspace.fs.readFile(target);
      const content = Buffer.from(bytes).toString('utf8');
      const sqlRel = workspaceRelative(targetSql);
      const next = updateSourcePath(content, sqlRel);
      if (next !== content) {
        await vscode.workspace.fs.writeFile(target, Buffer.from(next, 'utf8'));
      }
    }
  }
}

export async function runQueryFolderMigrationIfNeeded(): Promise<void> {
  const dpDir = await ensureDPDirs();
  const stateUri = getStateUri(dpDir);
  if (await fileExists(stateUri)) return;

  const queriesRoot = getQueriesRoot(dpDir);
  const profiles = await loadConnectionProfiles();
  const existingIndex = await loadExistingIndex(dpDir);
  const indexByPath = new Map((existingIndex?.queries || []).map(entry => [entry.path, entry]));
  const manifest: QueryMigrationManifest = {
    version: '1',
    startedAt: new Date().toISOString(),
    moved: [],
    skipped: [],
    warnings: [],
  };

  let movedBundles = 0;
  try {
    const allFiles = await walkFiles(queriesRoot);
    const sqlFiles = allFiles.filter(file => Boolean(sqlExtension(file)));

    for (const sqlFile of sqlFiles) {
      if (!await fileExists(sqlFile)) continue;
      const relUnderQueries = relativeUnder(queriesRoot, sqlFile);
      if (isAlreadyUnderConnectionFolder(relUnderQueries, profiles)) {
        manifest.skipped.push(workspaceRelative(sqlFile));
        continue;
      }

      const metadata = await readCompanionMetadata(sqlFile);
      const indexEntry = indexByPath.get(workspaceRelative(sqlFile));
      const profile = resolveProfileByMetadata(metadata, indexEntry, profiles);
      const connectionFolder = profile
        ? sanitizeQueryConnectionFolderName(profile.name, profile.id)
        : UNASSIGNED_QUERY_FOLDER;

      const targetDir = getConnectionQueriesDir(dpDir, connectionFolder);
      const targetSqlInitial = vscode.Uri.joinPath(targetDir, relUnderQueries);
      const target = await nextAvailableTarget(targetSqlInitial);
      const bundle = await collectBundle(sqlFile);
      await moveBundle(bundle, sqlFile, target.sql, target.suffix);
      manifest.moved.push({
        source: workspaceRelative(sqlFile),
        destination: workspaceRelative(target.sql),
        connectionFolder,
        collision: target.collision || undefined,
      });
      movedBundles++;
    }

    manifest.completedAt = new Date().toISOString();
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dpDir, 'system', 'migrations'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dpDir, 'system', 'migration_backup'));
    await writeJson(getManifestUri(dpDir), manifest);
    await writeJson(stateUri, {
      version: '1',
      status: 'complete',
      attemptedAt: manifest.startedAt,
      completedAt: manifest.completedAt,
      movedBundles,
    } satisfies QueryMigrationState);
    await rebuildQueryIndex();
  } catch (err) {
    manifest.completedAt = new Date().toISOString();
    manifest.warnings.push(`Migration failed: ${String(err)}`);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dpDir, 'system', 'migrations'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dpDir, 'system', 'migration_backup'));
    await writeJson(getManifestUri(dpDir), manifest);
    await writeJson(stateUri, {
      version: '1',
      status: 'failed',
      attemptedAt: manifest.startedAt,
      completedAt: manifest.completedAt,
      error: String(err),
      movedBundles,
    } satisfies QueryMigrationState);
    Logger.error('Query folder migration failed', err);
  }
}
