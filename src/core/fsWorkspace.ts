
import * as vscode from 'vscode';
import { Logger } from './logger';

export async function ensureDPDirs(): Promise<vscode.Uri> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) {
    throw new Error('No workspace folder open.');
  }
  const root = folders[0].uri;
  const dpDir = vscode.Uri.joinPath(root, 'RunQL');

  // Create RunQL directory (ignore if already exists)
  try {
    await vscode.workspace.fs.createDirectory(dpDir);
  } catch {
    // Directory already exists - this is expected and safe to ignore
  }

  // Create subdirs (ignore if already exist)
  const subs = ['schemas', 'queries', 'system', 'system/erd', 'system/prompts'];
  for (const s of subs) {
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dpDir, s));
    } catch {
      // Directory already exists - this is expected and safe to ignore
    }
  }

  return dpDir;
}

export async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(uri: vscode.Uri): Promise<T> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = new TextDecoder().decode(bytes);
  if (!text || !text.trim()) {
    throw new Error(`File is empty: ${uri.fsPath}`);
  }
  return JSON.parse(text);
}

export async function writeJson(uri: vscode.Uri, data: unknown): Promise<void> {
  const text = JSON.stringify(data, null, 2);
  const bytes = new TextEncoder().encode(text);
  await vscode.workspace.fs.writeFile(uri, bytes);
}

export async function listFiles(dir: vscode.Uri): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    // entries is [name, type][]
    return entries.map(([name, _type]) => name);
  } catch (e) {
    Logger.warn(`listFiles failed for ${dir.toString()}`, e);
    return [];
  }
}

/**
 * Ensure AGENTS.md exists in the project root.
 * If AGENTS.md already exists, create AGENTS_RUNQL.md instead.
 */
export async function ensureAgentsMd(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return;

  const root = folders[0].uri;
  const agentsUri = vscode.Uri.joinPath(root, 'AGENTS.md');
  const fallbackUri = vscode.Uri.joinPath(root, 'AGENTS_RUNQL.md');

  // If both files exist, nothing to do
  if (await fileExists(agentsUri)) {
    if (await fileExists(fallbackUri)) return;
    // AGENTS.md exists but not ours — use fallback name
    const targetUri = fallbackUri;
    const bytes = new TextEncoder().encode(agentsContent());
    await vscode.workspace.fs.writeFile(targetUri, bytes);
    return;
  }

  const bytes = new TextEncoder().encode(agentsContent());
  await vscode.workspace.fs.writeFile(agentsUri, bytes);
}

function agentsContent(): string {
  return `# Agent Guidance

This repo stores SQL, schemas, and ERD metadata in known locations. When a user asks for SQL, look for existing artifacts first, then use schema and documentation to build something new only if needed.

## Source Locations

- Existing queries: \`RunQL/queries/\` (may include subdirectories).
- Query index: \`RunQL/system/queryIndex.json\` (this is auto updated when a query is saved)
- Schemas and descriptions: \`RunQL/schemas/\` (these are auto create when a connection is added)
- ERD files: \`RunQL/system/erd/\` (these get auto created when a user clicks view ERD)

## Required Workflow (SQL Queries)

1. Search for existing queries first.
   - Check \`RunQL/queries/\` (including subdirectories) and \`RunQL/system/queryIndex.json\`.
2. If nothing relevant exists, read the schema and docs.
   - Use \`RunQL/schemas/\` for table/column definitions, relationships (if available), and descriptions.
   - Use \`RunQL/system/erd/\` if populated, to understand joins and relationships.
3. Only then should you create a new SQL query file (.sql)
   - Prefer to reuse or extend existing patterns when possible.
   - Do NOT create any other RunQL files when creating sql - only create .sql files

## Required Workflow (Documentation Requests)

1. SQL Query Documentation:
   - If a user asks you to document an SQL query, follow the prompt in \`RunQL/system/prompts/markdownDoc.txt\`.
   - Output the file in the exact same directory as the query (\`RunQL/queries/\`) with the same name but a different extension.
   - Example: \`olympic_gold.sql\` -> \`olympic_gold.md\`.
2. Schema Description:
   - If a user asks you to describe a schema, follow the prompt in \`RunQL/system/prompts/describeSchema.txt\`.
   - Output the results to \`RunQL/schemas/\` with the same name as the connection but a different extension.
   - Example: \`olympics_db.json\` -> \`olympics_db.description.json\`.
3. Inline Comments:
   - If a user asks you to create inline comments on an SQL file, follow the prompt in \`RunQL/system/prompts/inlineComments.txt\`.

## Notes

- If an existing query partially answers the request, adapt it rather than starting from scratch.
- Keep outputs consistent with the repository's established conventions and naming.
`;
}

/**
 * Ensure README_RUNQL.md exists in the project root with project setup instructions.
 */
export async function ensureReadmeMd(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return;

  const root = folders[0].uri;
  const readmeUri = vscode.Uri.joinPath(root, 'README_RUNQL.md');

  if (await fileExists(readmeUri)) return;

  const content = `# RunQL Project

This project uses RunQL for SQL workflows and schema exploration.

## Setup

1. **Git Configuration**:
   The \`RunQL/system/\` directory contains generated system files and indices that usually do not need to be committed to version control.

   Recommended \`.gitignore\` entry:
   \`\`\`gitignore
   RunQL/system/
   \`\`\`

   *Note: \`RunQL/queries/\` and \`RunQL/schemas/\` SHOULD be committed as they contain your source artifacts.*

## Folder Structure

- **RunQL/queries/**: Saved SQL queries.
- **RunQL/schemas/**: Schema definitions and descriptions.
- **RunQL/system/**: generated indexes, ERD data, and prompts (optional to commit).
`;

  const bytes = new TextEncoder().encode(content);
  await vscode.workspace.fs.writeFile(readmeUri, bytes);
}
