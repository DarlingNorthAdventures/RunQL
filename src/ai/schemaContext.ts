import * as vscode from "vscode";
import { loadSchemas } from "../schema/schemaStore";
import { extractTables } from "../util/sqlParseHeuristics";
import { ensureDPDirs, fileExists, readJson } from "../core/fsWorkspace";
import { loadDescriptions } from "../schema/descriptionStore";
import { resolveSchemaBundlePaths } from "../schema/schemaPaths";
import { Logger } from "../core/logger";

/** A single table entry in the schema context sent to AI */
interface SchemaContextTable {
    schema: string;
    table: string;
    description?: string;
    columns: { name: string; type: string; description?: string }[];
}

/** Top-level structure for schema context sent to AI */
interface SchemaContextData {
    tables: SchemaContextTable[];
    meta: unknown[];
    relationships: unknown[];
}

export async function buildSchemaContext(sqlText: string, connectionId?: string): Promise<string> {
    const config = vscode.workspace.getConfiguration("runql");
    if (!config.get<boolean>("ai.sendSchemaContext", true)) return "";

    const maxChars = config.get<number>("ai.maxSchemaChars", 150000);
    const referenced = extractTables(sqlText);
    if (referenced.length === 0) return "";

    const schemas = await loadSchemas();
    const introspection = connectionId
        ? schemas.find(s => s.connectionId === connectionId)
        : schemas[0];

    if (!introspection) return "";

    const context: SchemaContextData = { tables: [], meta: [], relationships: [] };

    const descriptionsBySchema = new Map<string, Awaited<ReturnType<typeof loadDescriptions>>>();

    for (const ref of referenced) {
        const [schemaName, tableName] = ref.split('.');
        const schema = introspection.schemas.find(s => s.name === schemaName);
        const table = schema?.tables.find(t => t.name === tableName)
            || (schema?.views || []).find(v => v.name === tableName);
        if (table) {
            if (!descriptionsBySchema.has(schemaName)) {
                descriptionsBySchema.set(schemaName, await loadDescriptions(introspection.connectionId, introspection.connectionName, schemaName));
            }
            const descriptions = descriptionsBySchema.get(schemaName);
            const tableKey = `${schemaName}.${tableName}`;
            const tDesc = descriptions?.tables?.[tableKey]?.description;

            context.tables.push({
                schema: schemaName,
                table: tableName,
                description: tDesc,
                columns: table.columns.map(c => {
                    const colKey = `${tableKey}.${c.name}`;
                    return {
                        name: c.name,
                        type: c.type,
                        description: descriptions?.columns?.[colKey]?.description
                    };
                })
            });
        }
    }

    const dpDir = await ensureDPDirs();
    const referencedSchemas = Array.from(new Set(referenced.map(ref => ref.split('.')[0]).filter(Boolean)));
    for (const schemaName of referencedSchemas) {
        const paths = await resolveSchemaBundlePaths(dpDir, introspection.connectionId, introspection.connectionName, schemaName);
        if (await fileExists(paths.schema)) {
            try {
                context.meta.push(await readJson(paths.schema));
            } catch (e) {
                Logger.warn(`Failed to load schema metadata from ${paths.schema.fsPath}`, e);
            }
        }
        if (await fileExists(paths.customRelationships)) {
            try {
                context.relationships.push(await readJson(paths.customRelationships));
            } catch (e) {
                // Failed to parse relationships JSON - file may be corrupted, continue without it
                Logger.warn(`Failed to load relationships from ${paths.customRelationships.fsPath}`, e);
            }
        }
    }

    let text = JSON.stringify(context, null, 2);
    if (text.length > maxChars) {
        text = text.slice(0, maxChars) + "\n...truncated...";
    }
    return text;
}
