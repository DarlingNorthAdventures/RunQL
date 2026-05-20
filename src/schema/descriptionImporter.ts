import * as vscode from 'vscode';
import { loadDescriptions, saveDescriptions } from './descriptionStore';
import { Logger } from '../core/logger';
import { buildSchemaBundlePaths, listSchemaBundleDirs } from './schemaPaths';
import { readJson } from '../core/fsWorkspace';
import { SchemaIntrospection } from '../core/types';

interface AIDescriptionResponse {
    schemaDescription?: string;
    table?: { key?: string; description?: string };
    columns?: Array<{ key: string; description: string; sampleValue?: string }>;
}

/**
 * Imports AI-generated schema description responses from the active editor or clipboard.
 * Parses one or more JSON blocks and merges them into the description store
 * using the same rules as direct generation (manual entries are preserved).
 */
export async function importSchemaDescriptionResponses(_context: vscode.ExtensionContext): Promise<void> {
    // 1. Get text from active editor or clipboard
    const editor = vscode.window.activeTextEditor;
    let text: string;
    if (editor && editor.document.getText().trim().length > 0) {
        text = editor.document.getText();
    } else {
        text = await vscode.env.clipboard.readText();
    }

    if (!text.trim()) {
        vscode.window.showWarningMessage('No content found. Paste JSON responses into an editor or copy them to the clipboard.');
        return;
    }

    // 2. Parse JSON blocks
    const blocks = extractJsonBlocks(text);
    if (blocks.length === 0) {
        vscode.window.showWarningMessage('No valid description JSON found in the content.');
        return;
    }

    // 3. Pick target description file
    const { ensureDPDirs } = await import('../core/fsWorkspace');
    const dpDir = await ensureDPDirs();
    const bundleDirs = await listSchemaBundleDirs(dpDir);
    if (bundleDirs.length === 0) {
        vscode.window.showWarningMessage('No description files found. Generate descriptions first to create the target file.');
        return;
    }

    const items = await Promise.all(bundleDirs.map(async (bundleDir) => {
        const paths = buildSchemaBundlePaths(bundleDir);
        let schema: SchemaIntrospection | undefined;
        try {
            schema = await readJson<SchemaIntrospection>(paths.schema);
        } catch {
            schema = undefined;
        }
        return {
            label: schema?.connectionName || (bundleDir.path.split('/').pop() || bundleDir.fsPath),
            description: paths.description.path.split('/').pop() || paths.description.fsPath,
            connectionId: schema?.connectionId,
            connectionName: schema?.connectionName,
            schemaName: schema?.schemas?.[0]?.name,
            uri: paths.description
        };
    }));

    const picked = items.length === 1
        ? items[0]
        : await vscode.window.showQuickPick(items, {
            placeHolder: 'Select the description file to import into'
        });

    if (!picked) return;

    const existing = picked.connectionId
        ? await loadDescriptions(picked.connectionId, picked.connectionName, picked.schemaName)
        : null;
    if (!existing) {
        vscode.window.showWarningMessage(`Could not load ${picked.description}.`);
        return;
    }

    // 4. Merge
    let merged = 0;
    for (const block of blocks) {
        const response = validateDescriptionResponse(block);
        if (!response) continue;

        // Schema description
        if (response.schemaDescription && !existing.schemaDescription) {
            existing.schemaDescription = response.schemaDescription;
        }

        // Table description
        if (response.table?.key && response.table.description) {
            const existingEntry = existing.tables[response.table.key];
            if (!existingEntry || existingEntry.source === 'ai') {
                existing.tables[response.table.key] = {
                    description: response.table.description,
                    source: 'ai',
                    confidence: 0.9,
                    stale: false
                };
                merged++;
            }
        }

        // Column descriptions
        if (response.columns && Array.isArray(response.columns)) {
            for (const col of response.columns) {
                if (!col.key || !col.description) continue;
                const existingCol = existing.columns[col.key];
                if (!existingCol || existingCol.source === 'ai') {
                    existing.columns[col.key] = {
                        description: col.description,
                        sampleValue: col.sampleValue,
                        source: 'ai',
                        confidence: 0.9,
                        stale: false
                    };
                    merged++;
                }
            }
        }
    }

    existing.generatedAt = new Date().toISOString();
    await saveDescriptions(existing.connectionId, existing.connectionName, existing, existing.schemaName);

    vscode.window.showInformationMessage(`Imported ${merged} description(s) into ${picked.description}.`);

    // Open the file
    const doc = await vscode.workspace.openTextDocument(picked.uri);
    await vscode.window.showTextDocument(doc);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractJsonBlocks(text: string): unknown[] {
    // Strip markdown code fences
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    const blocks: unknown[] = [];

    // Try as single JSON object first
    try {
        const parsed = JSON.parse(cleaned.trim());
        if (Array.isArray(parsed)) {
            return parsed;
        }
        return [parsed];
    } catch {
        // Not a single object — try to find multiple JSON objects
    }

    // Find JSON objects by matching top-level braces
    const regex = /\{[\s\S]*?\n\}/g;
    let match;
    while ((match = regex.exec(cleaned)) !== null) {
        try {
            blocks.push(JSON.parse(match[0]));
        } catch {
            // Skip invalid blocks
            Logger.debug(`Skipped invalid JSON block during import`);
        }
    }

    return blocks;
}

function validateDescriptionResponse(block: unknown): AIDescriptionResponse | null {
    if (!block || typeof block !== 'object') return null;
    const obj = block as Record<string, unknown>;

    // Must have at least a table or columns key
    if (!obj.table && !obj.columns) return null;

    return block as AIDescriptionResponse;
}
