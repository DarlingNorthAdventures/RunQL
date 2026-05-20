
import * as vscode from 'vscode';
import { ensureDPDirs, readJson, writeJson } from '../core/fsWorkspace';
import { DbDialect } from '../core/types';
import { getDescriptionUriForConnection } from './schemaPaths';

export interface DescriptionEntry {
    description: string;
    sampleValue?: string;
    confidence?: number;
    source: 'ai' | 'manual';
    stale?: boolean;
}

export interface SchemaDescriptionsFile {
    __runqlHeader: string;
    version: string;
    generatedAt: string;
    connectionId: string;
    connectionName?: string;
    dialect: DbDialect;
    schemaName: string;
    schemaDescription?: string; // Top-level description of the schema
    tables: Record<string, DescriptionEntry>; // key: "schema.table"
    columns: Record<string, DescriptionEntry>; // key: "schema.table.column"
}

export async function loadDescriptions(connectionId: string, connectionName?: string, schemaName = 'main'): Promise<SchemaDescriptionsFile | null> {
    try {
        const dpDir = await ensureDPDirs();
        const uri = await getDescriptionUriForConnection(dpDir, connectionId, connectionName, schemaName);
        return await readJson<SchemaDescriptionsFile>(uri);
    } catch (_e) {
        return null;
    }
}

export async function saveDescriptions(connectionId: string, connectionName: string | undefined, data: SchemaDescriptionsFile, schemaName = data.schemaName || 'main'): Promise<void> {
    const dpDir = await ensureDPDirs();
    const uri = await getDescriptionUriForConnection(dpDir, connectionId, connectionName, schemaName);
    await writeJson(uri, data);
}
