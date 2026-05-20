import * as vscode from "vscode";
import { ConnectionProfile, ConnectionSecrets } from "../core/types";
import { ensureDPDirs, fileExists, readJson, writeJson } from "../core/fsWorkspace";
import { Logger } from '../core/logger';
import { normalizeConnectionType } from './connectionType';
import { isReservedConnectionFolderName, normalizedConnectionFolderKey } from '../schema/schemaPaths';

let secretStorage: vscode.SecretStorage | undefined;

export function initConnectionStore(context: vscode.ExtensionContext) {
  secretStorage = context.secrets;
}

interface ConnectionsFile {
  version: "0.1";
  generatedAt: string;
  connections: ConnectionProfile[];
}

async function getConnectionsUri(createIfMissing = false): Promise<vscode.Uri | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return undefined;

  if (createIfMissing) {
    const dpDir = await ensureDPDirs();
    return vscode.Uri.joinPath(dpDir, "system", "connections.json");
  }

  // Read-only path resolution must not create folders.
  return vscode.Uri.joinPath(root, "RunQL", "system", "connections.json");
}

export async function loadConnectionProfiles(): Promise<ConnectionProfile[]> {
  const uri = await getConnectionsUri(false);
  if (!uri) return [];
  let connections: ConnectionProfile[] = [];

  if (await fileExists(uri)) {
    try {
      const file = await readJson<ConnectionsFile>(uri);
      connections = file.connections || [];

      // Migration: 'type' -> 'dialect' (v0 legacy fix)
      let changed = false;
      connections.forEach((c) => {
        const legacy = c as unknown as Record<string, unknown>;
        if (!legacy.dialect && legacy.type) {
          legacy.dialect = legacy.type;
          delete legacy.type;
          changed = true;
        }
        const normalizedConnectionType = normalizeConnectionType(legacy.connectionType);
        if (legacy.connectionType !== normalizedConnectionType) {
          legacy.connectionType = normalizedConnectionType;
          changed = true;
        }
      });

      if (changed) {
        await writeJson(uri, { ...file, connections });
      }

    } catch (e) {
      Logger.error("Failed to load connections.json", e);
    }
  }

  return connections;
}

export async function saveConnectionProfile(profile: ConnectionProfile): Promise<void> {
  const uri = await getConnectionsUri(true);
  if (!uri) {
    throw new Error("No workspace folder open.");
  }
  let connections = await loadConnectionProfiles();
  profile.connectionType = normalizeConnectionType(profile.connectionType);

  const nameError = await validateConnectionName(profile.name, profile.id);
  if (nameError) {
    throw new Error(nameError);
  }

  const idx = connections.findIndex(c => c.id === profile.id);
  if (idx >= 0) {
    // Check for name change
    const existing = connections[idx];
    if (existing.name !== profile.name) {
      // Renamed!
      try {
        const { renameSchemaFiles } = require('../schema/schemaStore');
        const { renameQueryConnectionFolder } = require('../queryLibrary/queryStorage');
        await renameSchemaFiles(profile.id, existing.name, profile.name);
        await renameQueryConnectionFolder(profile.id, existing.name, profile.name);
      } catch (e) {
        Logger.error("Failed to rename connection-scoped files:", e);
      }
    }
    connections[idx] = profile;
  } else {
    connections.push(profile);
  }

  const file: ConnectionsFile = {
    version: "0.1",
    generatedAt: new Date().toISOString(),
    connections
  };
  await writeJson(uri, file);
}

export async function deleteConnection(id: string): Promise<void> {
  const uri = await getConnectionsUri(true);
  if (!uri) {
    throw new Error("No workspace folder open.");
  }
  let connections = await loadConnectionProfiles();
  const existing = connections.find(c => c.id === id);
  if (existing) {
    try {
      const { archiveSchemaFilesForDeletedConnection } = require('../schema/schemaStore');
      const { archiveQueryConnectionFolder } = require('../queryLibrary/queryStorage');
      await archiveSchemaFilesForDeletedConnection(existing.id, existing.name);
      await archiveQueryConnectionFolder(existing.id, existing.name);
    } catch (e) {
      Logger.error("Failed to archive connection-scoped files:", e);
    }
  }
  connections = connections.filter(c => c.id !== id);

  const file: ConnectionsFile = {
    version: "0.1",
    generatedAt: new Date().toISOString(),
    connections
  };
  await writeJson(uri, file);

  // also delete secrets
  if (secretStorage) {
    await secretStorage.delete(`runql.secrets.${id}`);
  }
}

const sessionSecrets = new Map<string, string>(); // JSON stringified

export async function getConnectionSecrets(id: string): Promise<ConnectionSecrets> {
  // Determine mode from profile
  const profile = await getConnection(id);
  // Default to 'secretStorage' for legacy compatibility if undefined
  const mode = profile?.credentialStorageMode || 'secretStorage';

  if (mode === 'session') {
    if (sessionSecrets.has(id)) {
      try {
        return JSON.parse(sessionSecrets.get(id)!);
      } catch {
        return {};
      }
    }
    return {};
  } else if (mode === 'secretStorage') {
    if (!secretStorage) { return {}; }
    const json = await secretStorage.get(`runql.secrets.${id}`);
    if (!json) { return {}; }
    try {
      return JSON.parse(json) as ConnectionSecrets;
    } catch {
      return {};
    }
  }
  return {};
}

export async function saveConnectionSecrets(id: string, secrets: ConnectionSecrets, explicitMode?: 'session' | 'secretStorage' | 'browser'): Promise<void> {
  let mode = explicitMode;
  if (!mode) {
    const profile = await getConnection(id);
    mode = profile?.credentialStorageMode || 'secretStorage';
  }

  if (mode === 'session') {
    sessionSecrets.set(id, JSON.stringify(secrets));
    // Optional: Clear from secretStorage if previously there?
    // For safety/cleanup, we could attempts to delete from secretStorage.
    if (secretStorage) {
      await secretStorage.delete(`runql.secrets.${id}`);
    }
  } else if (mode === 'secretStorage') {
    if (!secretStorage) {
      throw new Error("SecretStorage not initialized");
    }
    await secretStorage.store(`runql.secrets.${id}`, JSON.stringify(secrets));
    // Clear from session if exists
    sessionSecrets.delete(id);
  }
}

export async function validateConnectionName(name: string, excludeId?: string): Promise<string | undefined> {
  const profiles = await loadConnectionProfiles();
  const clean = name.trim();
  if (!clean) return "Name cannot be empty";

  if (isReservedConnectionFolderName(clean)) {
    return "'Unassigned' is reserved by RunQL. Choose a different connection name.";
  }

  const cleanKey = normalizedConnectionFolderKey(clean);
  const conflict = profiles.find(p => normalizedConnectionFolderKey(p.name) === cleanKey && p.id !== excludeId);
  if (conflict) {
    return `Connection name '${clean}' is already in use.`;
  }
  return undefined;
}
// Helper to get single connection
export async function getConnection(id: string): Promise<ConnectionProfile | undefined> {
  const profiles = await loadConnectionProfiles();
  return profiles.find(p => p.id === id);
}
