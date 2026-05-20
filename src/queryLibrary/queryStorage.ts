import * as vscode from 'vscode';
import { ensureDPDirs, fileExists, readJson, writeJson } from '../core/fsWorkspace';
import { Logger } from '../core/logger';
import { sanitizeSchemaBundleName } from '../schema/schemaPaths';
import { QueryIndexFile } from './queryIndexer';

export const UNASSIGNED_QUERY_FOLDER = 'Unassigned';

export function sanitizeQueryConnectionFolderName(connectionName?: string, connectionId?: string): string {
  const sanitized = sanitizeSchemaBundleName(connectionName, connectionId);
  return sanitized || UNASSIGNED_QUERY_FOLDER;
}

export function getQueriesRoot(dpDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(dpDir, 'queries');
}

export function getConnectionQueriesDir(dpDir: vscode.Uri, connectionName?: string, connectionId?: string): vscode.Uri {
  return vscode.Uri.joinPath(getQueriesRoot(dpDir), sanitizeQueryConnectionFolderName(connectionName, connectionId));
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
    // Ignore absent folders.
  }
  return files;
}

function updateFrontmatterField(content: string, key: string, value: string | boolean): string {
  const rendered = typeof value === 'boolean' ? String(value) : `"${value.replace(/"/g, '\\"')}"`;
  if (!content.startsWith('---')) return content;
  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) return content;
  const head = content.slice(0, endIdx);
  const rest = content.slice(endIdx);
  const re = new RegExp(`^${key}:\\s*.*$`, 'm');
  if (re.test(head)) {
    return `${head.replace(re, `${key}: ${rendered}`)}${rest}`;
  }
  return `${head}\n${key}: ${rendered}${rest}`;
}

async function updateMarkdownFiles(dir: vscode.Uri, updater: (content: string) => string | Promise<string>): Promise<void> {
  const files = await walkFiles(dir);
  for (const file of files) {
    if (!file.path.toLowerCase().endsWith('.md')) continue;
    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      const content = Buffer.from(bytes).toString('utf8');
      const next = await updater(content);
      if (next !== content) {
        await vscode.workspace.fs.writeFile(file, Buffer.from(next, 'utf8'));
      }
    } catch (err) {
      Logger.warn(`Failed to update query markdown ${file.fsPath}`, err);
    }
  }
}

async function updateQueryIndexConnectionName(oldFolder: vscode.Uri, newFolder: vscode.Uri, newName: string): Promise<void> {
  const dpDir = await ensureDPDirs();
  const indexUri = vscode.Uri.joinPath(dpDir, 'system', 'queries', 'queryIndex.json');
  if (!await fileExists(indexUri)) return;

  try {
    const index = await readJson<QueryIndexFile>(indexUri);
    const asRelative = (uri: vscode.Uri) => {
      if (typeof vscode.workspace.asRelativePath === 'function') {
        return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
      }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      return root ? uri.fsPath.replace(`${root}/`, '').replace(/\\/g, '/') : uri.fsPath;
    };
    const oldRel = asRelative(oldFolder);
    const newRel = asRelative(newFolder);
    for (const entry of index.queries) {
      if (entry.path.startsWith(`${oldRel}/`)) {
        entry.path = `${newRel}/${entry.path.slice(oldRel.length + 1)}`;
        if (entry.docPath?.startsWith(`${oldRel}/`)) {
          entry.docPath = `${newRel}/${entry.docPath.slice(oldRel.length + 1)}`;
        }
        entry.connectionName = newName;
      }
    }
    await writeJson(indexUri, index);
  } catch (err) {
    Logger.warn('Failed to update query index after connection folder rename', err);
  }
}

export async function renameQueryConnectionFolder(connectionId: string, oldName: string, newName: string): Promise<void> {
  const dpDir = await ensureDPDirs();
  const oldDir = getConnectionQueriesDir(dpDir, oldName, connectionId);
  if (!await fileExists(oldDir)) return;

  let newDir = getConnectionQueriesDir(dpDir, newName, connectionId);
  if (oldDir.fsPath === newDir.fsPath) {
    await updateMarkdownFiles(oldDir, (content) => updateFrontmatterField(content, 'connection', newName));
    return;
  }

  if (await fileExists(newDir)) {
    newDir = vscode.Uri.joinPath(getQueriesRoot(dpDir), `${sanitizeQueryConnectionFolderName(newName, connectionId)}--${connectionId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'queries'}`);
  }

  try {
    await vscode.workspace.fs.rename(oldDir, newDir, { overwrite: false });
  } catch (err) {
    Logger.warn(`Failed to rename query folder ${oldDir.fsPath}`, err);
    return;
  }

  await updateMarkdownFiles(newDir, (content) => updateFrontmatterField(content, 'connection', newName));
  await updateQueryIndexConnectionName(oldDir, newDir, newName);
}

export async function archiveQueryConnectionFolder(connectionId: string, connectionName?: string): Promise<void> {
  const dpDir = await ensureDPDirs();
  const sourceDir = getConnectionQueriesDir(dpDir, connectionName, connectionId);
  if (!await fileExists(sourceDir)) return;

  const base = `${sanitizeQueryConnectionFolderName(connectionName, connectionId)}_deleted`;
  let targetDir = vscode.Uri.joinPath(getQueriesRoot(dpDir), base);
  if (await fileExists(targetDir)) {
    targetDir = vscode.Uri.joinPath(getQueriesRoot(dpDir), `${base}--${connectionId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'queries'}`);
  }

  try {
    await vscode.workspace.fs.rename(sourceDir, targetDir, { overwrite: false });
  } catch (err) {
    Logger.warn(`Failed to archive query folder ${sourceDir.fsPath}`, err);
    return;
  }

  await updateMarkdownFiles(targetDir, (content) => {
    let next = updateFrontmatterField(content, 'stale', true);
    next = updateFrontmatterField(next, 'deleted_connection', true);
    return next;
  });
}
