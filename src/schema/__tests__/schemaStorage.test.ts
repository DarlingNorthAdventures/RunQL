import * as vscode from 'vscode';
import { SchemaIntrospection } from '../../core/types';
import { loadSchemas, renameSchemaFiles, saveSchema } from '../schemaStore';
import { resolveSchemaBundlePaths } from '../schemaPaths';
import { runSchemaBundleMigrationIfNeeded } from '../storageMigration';

type Entry =
  | { kind: 'dir' }
  | { kind: 'file'; bytes: Uint8Array };

const fsMap = new Map<string, Entry>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizePath(input: string): string {
  if (!input) return '/';
  const normalized = input.replace(/\/+/g, '/').replace(/\/$/, '');
  return normalized.length > 0 ? normalized : '/';
}

function ensureDir(path: string): void {
  const normalized = normalizePath(path);
  if (normalized === '/') {
    fsMap.set('/', { kind: 'dir' });
    return;
  }

  const parts = normalized.split('/').filter(Boolean);
  let current = '';
  fsMap.set('/', { kind: 'dir' });
  for (const part of parts) {
    current += `/${part}`;
    fsMap.set(current, { kind: 'dir' });
  }
}

function readJsonAt<T>(path: string): T {
  const entry = fsMap.get(normalizePath(path));
  if (!entry || entry.kind !== 'file') {
    throw new Error(`Missing file at ${path}`);
  }
  return JSON.parse(decoder.decode(entry.bytes)) as T;
}

function writeJsonAt(path: string, data: unknown): void {
  const normalized = normalizePath(path);
  ensureDir(normalized.split('/').slice(0, -1).join('/'));
  fsMap.set(normalized, { kind: 'file', bytes: encoder.encode(JSON.stringify(data, null, 2)) });
}

function fileExists(path: string): boolean {
  return fsMap.has(normalizePath(path));
}

function configureWorkspaceFs(): void {
  (vscode.workspace.workspaceFolders as unknown) = [{ uri: vscode.Uri.file('/workspace') }];

  const createDirectoryMock = vscode.workspace.fs.createDirectory as jest.Mock;
  const writeFileMock = vscode.workspace.fs.writeFile as jest.Mock;
  const readFileMock = vscode.workspace.fs.readFile as jest.Mock;
  const statMock = vscode.workspace.fs.stat as jest.Mock;
  const readDirectoryMock = vscode.workspace.fs.readDirectory as jest.Mock;
  const deleteMock = vscode.workspace.fs.delete as jest.Mock;
  const renameMock = vscode.workspace.fs.rename as jest.Mock;

  createDirectoryMock.mockImplementation(async (uri: vscode.Uri) => {
    ensureDir(uri.path);
  });

  writeFileMock.mockImplementation(async (uri: vscode.Uri, bytes: Uint8Array) => {
    const normalized = normalizePath(uri.path);
    ensureDir(normalized.split('/').slice(0, -1).join('/'));
    fsMap.set(normalized, { kind: 'file', bytes });
  });

  readFileMock.mockImplementation(async (uri: vscode.Uri) => {
    const entry = fsMap.get(normalizePath(uri.path));
    if (!entry || entry.kind !== 'file') {
      throw new Error(`ENOENT: ${uri.path}`);
    }
    return entry.bytes;
  });

  statMock.mockImplementation(async (uri: vscode.Uri) => {
    const entry = fsMap.get(normalizePath(uri.path));
    if (!entry) {
      throw new Error(`ENOENT: ${uri.path}`);
    }
    return { type: entry.kind === 'dir' ? 2 : 1 };
  });

  readDirectoryMock.mockImplementation(async (uri: vscode.Uri) => {
    const root = normalizePath(uri.path);
    const prefix = root === '/' ? '/' : `${root}/`;
    const names = new Map<string, number>();

    for (const [path, entry] of fsMap.entries()) {
      if (path === root || !path.startsWith(prefix)) continue;
      const remainder = path.slice(prefix.length);
      if (!remainder || remainder.includes('/')) continue;
      names.set(remainder, entry.kind === 'dir' ? 2 : 1);
    }

    return Array.from(names.entries());
  });

  deleteMock.mockImplementation(async (uri: vscode.Uri, options?: { recursive?: boolean }) => {
    const target = normalizePath(uri.path);
    if (options?.recursive) {
      for (const path of Array.from(fsMap.keys())) {
        if (path === target || path.startsWith(`${target}/`)) {
          fsMap.delete(path);
        }
      }
      return;
    }
    fsMap.delete(target);
  });

  renameMock.mockImplementation(async (oldUri: vscode.Uri, newUri: vscode.Uri, options?: { overwrite?: boolean }) => {
    const source = normalizePath(oldUri.path);
    const target = normalizePath(newUri.path);
    const sourceEntry = fsMap.get(source);
    if (!sourceEntry) {
      throw new Error(`ENOENT: ${oldUri.path}`);
    }

    if (options?.overwrite) {
      for (const path of Array.from(fsMap.keys())) {
        if (path === target || path.startsWith(`${target}/`)) {
          fsMap.delete(path);
        }
      }
    }

    ensureDir(target.split('/').slice(0, -1).join('/'));

    if (sourceEntry.kind === 'file') {
      fsMap.set(target, sourceEntry);
      fsMap.delete(source);
      return;
    }

    const descendants = Array.from(fsMap.entries())
      .filter(([path]) => path === source || path.startsWith(`${source}/`))
      .sort(([left], [right]) => left.length - right.length);

    for (const [path, entry] of descendants) {
      const movedPath = path === source ? target : `${target}${path.slice(source.length)}`;
      fsMap.set(movedPath, entry);
    }
    for (const [path] of descendants) {
      fsMap.delete(path);
    }
  });
}

function sampleSchema(connectionName = 'Analytics'): SchemaIntrospection {
  return {
    version: '0.2',
    generatedAt: '2026-04-16T12:00:00.000Z',
    connectionId: 'conn-1234',
    connectionName,
    dialect: 'postgres',
    schemas: [
      {
        name: 'public',
        tables: [
          {
            name: 'users',
            columns: [{ name: 'id', type: 'integer' }, { name: 'email', type: 'text' }],
            primaryKey: ['id'],
          }
        ],
        views: [],
        procedures: [],
        functions: [],
      }
    ]
  };
}

describe('schema storage', () => {
  beforeEach(() => {
    fsMap.clear();
    configureWorkspaceFs();
  });

  it('saves and loads schema bundles from per-connection folders', async () => {
    await saveSchema(sampleSchema());

    expect(fileExists('/workspace/RunQL/schemas/Analytics/manifest.json')).toBe(true);
    expect(fileExists('/workspace/RunQL/schemas/Analytics/public/schema.json')).toBe(true);
    expect(fileExists('/workspace/RunQL/schemas/Analytics/public/description.json')).toBe(true);
    expect(fileExists('/workspace/RunQL/schemas/Analytics/public/custom.relationships.json')).toBe(true);

    const loaded = await loadSchemas();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].connectionId).toBe('conn-1234');
    expect(loaded[0].docPath).toBe('/workspace/RunQL/schemas/Analytics/public/description.json');
    expect(loaded[0].customRelationshipsPath).toBe('/workspace/RunQL/schemas/Analytics/public/custom.relationships.json');
  });

  it('saves multi-schema introspection into one folder per schema and rehydrates the connection', async () => {
    const schema = sampleSchema();
    schema.schemas.push({
      name: 'billing',
      tables: [{ name: 'invoices', columns: [{ name: 'id', type: 'integer' }], primaryKey: ['id'] }],
      views: [],
      procedures: [],
      functions: [],
    });

    await saveSchema(schema);

    expect(fileExists('/workspace/RunQL/schemas/Analytics/public/schema.json')).toBe(true);
    expect(fileExists('/workspace/RunQL/schemas/Analytics/billing/schema.json')).toBe(true);

    const manifest = readJsonAt<{ schemas: Array<{ name: string; path: string }> }>('/workspace/RunQL/schemas/Analytics/manifest.json');
    expect(manifest.schemas.map(s => s.name).sort()).toEqual(['billing', 'public']);

    const loaded = await loadSchemas();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].schemas.map(s => s.name).sort()).toEqual(['billing', 'public']);
  });

  it('archives schema folders missing from a later introspection and removes them from active storage', async () => {
    const schema = sampleSchema();
    schema.schemas.push({
      name: 'billing',
      tables: [{ name: 'invoices', columns: [{ name: 'id', type: 'integer' }], primaryKey: ['id'] }],
      views: [],
      procedures: [],
      functions: [],
    });
    await saveSchema(schema);

    const nextSchema = sampleSchema();
    nextSchema.schemas = nextSchema.schemas.filter(s => s.name === 'public');
    await saveSchema(nextSchema);

    expect(fileExists('/workspace/RunQL/schemas/Analytics/billing')).toBe(false);
    expect(fileExists('/workspace/RunQL/schemas/deleted/Analytics/billing/schema.json')).toBe(true);

    const manifest = readJsonAt<{ schemas: Array<{ name: string; path: string }> }>('/workspace/RunQL/schemas/Analytics/manifest.json');
    expect(manifest.schemas.map(s => s.name)).toEqual(['public']);

    const archived = readJsonAt<Record<string, unknown>>('/workspace/RunQL/schemas/deleted/Analytics/billing/schema.json');
    expect(archived.deleted).toBe(true);
    expect(archived.stale).toBe(true);

    const loaded = await loadSchemas();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].schemas.map(s => s.name)).toEqual(['public']);
  });

  it('does not archive all existing schema folders when introspection returns no schemas', async () => {
    await saveSchema(sampleSchema());

    const emptySchema = sampleSchema();
    emptySchema.schemas = [];
    await saveSchema(emptySchema);

    expect(fileExists('/workspace/RunQL/schemas/Analytics/public/schema.json')).toBe(true);
    expect(fileExists('/workspace/RunQL/schemas/deleted/Analytics/public/schema.json')).toBe(false);

    const manifest = readJsonAt<{ schemas: Array<{ name: string; path: string }> }>('/workspace/RunQL/schemas/Analytics/manifest.json');
    expect(manifest.schemas.map(s => s.name)).toEqual(['public']);
  });

  it('renames the bundle folder and updates internal metadata', async () => {
    await saveSchema(sampleSchema());
    writeJsonAt('/workspace/RunQL/schemas/Analytics/public/erd.layout.json', {
      connectionName: 'Analytics',
      graphSignature: 'sig',
      positions: {}
    });

    await renameSchemaFiles('conn-1234', 'Analytics', 'Analytics Prod');

    expect(fileExists('/workspace/RunQL/schemas/Analytics')).toBe(false);
    expect(fileExists('/workspace/RunQL/schemas/Analytics_Prod/public/schema.json')).toBe(true);

    const schema = readJsonAt<SchemaIntrospection>('/workspace/RunQL/schemas/Analytics_Prod/public/schema.json');
    expect(schema.connectionName).toBe('Analytics Prod');
    expect(schema.docPath).toBe('/workspace/RunQL/schemas/Analytics_Prod/public/description.json');
    expect(schema.customRelationshipsPath).toBe('/workspace/RunQL/schemas/Analytics_Prod/public/custom.relationships.json');

    const description = readJsonAt<{ connectionName: string }>('/workspace/RunQL/schemas/Analytics_Prod/public/description.json');
    expect(description.connectionName).toBe('Analytics Prod');

    const layout = readJsonAt<{ connectionName: string }>('/workspace/RunQL/schemas/Analytics_Prod/public/erd.layout.json');
    expect(layout.connectionName).toBe('Analytics Prod');
  });

  it('does not create migration folders when no legacy schema files exist', async () => {
    await runSchemaBundleMigrationIfNeeded();

    expect(fileExists('/workspace/RunQL/system/migrations')).toBe(false);
    expect(fileExists('/workspace/RunQL/system/migration_backup')).toBe(false);
  });

  it('migrates legacy flat files once and moves originals into migration_backup', async () => {
    const legacySchema = sampleSchema('Legacy');
    writeJsonAt('/workspace/RunQL/schemas/Legacy.json', legacySchema);
    writeJsonAt('/workspace/RunQL/schemas/Legacy.description.json', {
      __runqlHeader: '#RunQL created',
      version: '0.1',
      generatedAt: '2026-04-16T12:00:00.000Z',
      connectionId: 'conn-1234',
      connectionName: 'Legacy',
      dialect: 'postgres',
      schemaName: 'public',
      tables: {},
      columns: {}
    });
    writeJsonAt('/workspace/RunQL/schemas/Legacy.custom.relationships.json', {
      version: '0.1',
      connectionId: 'conn-1234',
      connectionName: 'Legacy',
      relationships: []
    });
    writeJsonAt('/workspace/RunQL/system/erd/Legacy.erd.json', { nodes: [], edges: [] });
    writeJsonAt('/workspace/RunQL/system/erd/Legacy.layout.json', {
      connectionName: 'Legacy',
      graphSignature: 'sig',
      positions: {}
    });

    await runSchemaBundleMigrationIfNeeded();

    const bundlePaths = await resolveSchemaBundlePaths(vscode.Uri.file('/workspace/RunQL'), 'conn-1234', 'Legacy', 'public');
    expect(fileExists(bundlePaths.schema.fsPath)).toBe(true);
    expect(fileExists(bundlePaths.description.fsPath)).toBe(true);
    expect(fileExists(bundlePaths.customRelationships.fsPath)).toBe(true);
    expect(fileExists(bundlePaths.erd.fsPath)).toBe(true);
    expect(fileExists(bundlePaths.layout.fsPath)).toBe(true);

    expect(fileExists('/workspace/RunQL/schemas/Legacy.json')).toBe(false);
    expect(fileExists('/workspace/RunQL/system/erd/Legacy.erd.json')).toBe(false);
    expect(fileExists('/workspace/RunQL/system/erd')).toBe(false);
    expect(Array.from(fsMap.keys()).some(path => path.includes('/workspace/RunQL/system/migration_backup/schema-bundles-v2/') && path.endsWith('-Legacy.json'))).toBe(true);
    expect(Array.from(fsMap.keys()).some(path => path.includes('/workspace/RunQL/system/migration_backup/erd/') && path.endsWith('-Legacy.erd.json'))).toBe(true);

    const state = readJsonAt<{ status: string; migratedBundles: number }>('/workspace/RunQL/system/migrations/schema-bundles-v2.json');
    expect(state.status).toBe('complete');
    expect(state.migratedBundles).toBe(1);

    const manifest = readJsonAt<{ entries: Array<{ source: string; backup: string }> }>('/workspace/RunQL/system/migration_backup/schema-bundles-v2/manifest.json');
    expect(manifest.entries.some((entry) => entry.source.endsWith('/Legacy.json'))).toBe(true);
    expect(manifest.entries.some((entry) => entry.backup.includes('/migration_backup/erd/') && entry.backup.endsWith('-Legacy.erd.json'))).toBe(true);
  });

  it('renames existing bundle layout.json to erd.layout.json during startup normalization', async () => {
    await saveSchema(sampleSchema());
    writeJsonAt('/workspace/RunQL/schemas/Analytics/public/layout.json', {
      connectionName: 'Analytics',
      graphSignature: 'sig',
      positions: {}
    });

    await runSchemaBundleMigrationIfNeeded();

    expect(fileExists('/workspace/RunQL/schemas/Analytics/public/layout.json')).toBe(false);
    expect(fileExists('/workspace/RunQL/schemas/Analytics/public/erd.layout.json')).toBe(true);
  });
});
