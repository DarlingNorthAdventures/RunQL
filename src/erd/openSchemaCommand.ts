import * as vscode from 'vscode';
import { SchemaIntrospection } from '../core/types';
import { ERDViewProvider } from './erdViewProvider';

interface SchemaErdItem {
    introspection?: SchemaIntrospection;
    schemaModel?: { name: string };
}

export async function openSchemaErdCommand(context: vscode.ExtensionContext, item?: SchemaErdItem) {
    if (!item) {
        vscode.window.showErrorMessage("Select a schema to view ERD.");
        return;
    }

    const provider = ERDViewProvider.current;
    if (!provider) {
        vscode.window.showErrorMessage("ERD View not initialized.");
        return;
    }

    const { getConnection } = require('../connections/connectionStore');
    const { ensureConnectionSecrets } = require('../connections/connectionCommands');

    // Case 1: Standard Schema Item (with introspection)
    if (item.introspection) {
        const connectionId = item.introspection.connectionId;
        const profile = await getConnection(connectionId);

        if (!profile) {
            vscode.window.showErrorMessage("Connection profile not found.");
            return;
        }

        const secrets = await ensureConnectionSecrets(profile);
        if (!secrets) return;

        if (item.schemaModel?.name) {
            const { ensureDPDirs } = require('../core/fsWorkspace');
            const { resolveSchemaBundlePaths } = require('../schema/schemaPaths');
            const dpDir = await ensureDPDirs();
            const paths = await resolveSchemaBundlePaths(dpDir, connectionId, item.introspection.connectionName, item.schemaModel.name);
            const filtered: SchemaIntrospection = {
                ...item.introspection,
                docPath: paths.description.fsPath,
                customRelationshipsPath: paths.customRelationships.fsPath,
                schemas: item.introspection.schemas.filter((s: { name: string }) => s.name === item.schemaModel?.name)
            };
            await provider.showERD(profile, secrets, filtered);
            return;
        }

        // Open the ERD panel using the existing implementation (full connection)
        await provider.showERD(profile, secrets, item.introspection);
        return;
    }

    vscode.window.showErrorMessage("Select a schema to view ERD.");
}
